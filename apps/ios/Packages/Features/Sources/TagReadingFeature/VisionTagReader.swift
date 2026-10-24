import Core
import CoreGraphics
import Dispatch
import Foundation
import Vision

/// Reads tag and label photos with Apple Vision, entirely on the device.
///
/// Three passes run on the upright photo:
/// 1. Text recognition at the accurate level with language correction off, so codes such as
///    "RN 12345" or "AB1234" come back as printed instead of being "corrected" into words.
/// 2. Barcode detection for EAN-13 (which includes UPC-A), EAN-8, UPC-E, Code 128, and QR, at the
///    same time as the first pass.
/// 3. The size-tab pass (``SizeTabPass``) for small isolated sizes the first pass skips.
///
/// Reading runs off the main actor and stops with `CancellationError` at the next pass or tile
/// once its task is cancelled.
public struct VisionTagReader: TagReader {
    /// Latin-script languages of the care labels resellers see. Recognition is limited to these
    /// so Vision never switches to another script on its own.
    static let recognitionLanguages = ["en-US", "fr-FR", "es-ES", "it-IT", "de-DE", "pt-BR"]
        .map { Locale.Language(identifier: $0) }

    static let symbologies: [(Vision.BarcodeSymbology, TagBarcode.Symbology)] = [
        (.ean13, .ean13), (.ean8, .ean8), (.upce, .upce), (.code128, .code128), (.qr, .qr),
    ]

    /// The points a read passes, reported to ``onStage`` so tests can act between them.
    enum Stage: Equatable {
        case decoded
        case fullImagePassesFinished
        case sizeTabTileFinished(Int)
    }

    var onStage: (@Sendable (Stage) -> Void)?
    var runsSizeTabPass = true

    public init() {}

    @concurrent
    public func read(imageData: Data) async throws -> TagReading {
        dispatchPrecondition(condition: .notOnQueue(.main))
        let clock = ContinuousClock()
        let start = clock.now
        try Task.checkCancellation()

        let image = try UprightImage.decode(imageData)
        let decode = clock.now - start
        onStage?(.decoded)
        try Task.checkCancellation()

        async let text = Self.measure(clock) { try await Self.recognizeText(in: image) }
        async let barcodes = Self.measure(clock) { try await Self.detectBarcodes(in: image) }
        let (lines, textRecognition) = try await text
        let (detected, barcodeDetection) = try await barcodes
        onStage?(.fullImagePassesFinished)
        try Task.checkCancellation()

        var sizeTabLines: [TagTextLine] = []
        var sizeTabPass = Duration.zero
        if runsSizeTabPass {
            (sizeTabLines, sizeTabPass) = try await Self.measure(clock) {
                try await readSizeTabs(in: image, fullImageLines: lines)
            }
        }

        return TagReading(
            lines: lines + sizeTabLines,
            barcodes: detected,
            timing: TagReadingTiming(
                decode: decode,
                textRecognition: textRecognition,
                barcodeDetection: barcodeDetection,
                sizeTabPass: sizeTabPass,
                total: clock.now - start,
            ),
        )
    }

    // MARK: - Passes

    private static func recognizeText(in image: CGImage) async throws -> [TagTextLine] {
        try await recognize(image).compactMap { observation in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            let text = LatinFolding.fold(candidate.string).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return TagTextLine(
                text: text,
                confidence: Double(candidate.confidence),
                boundingBox: photoRect(observation.boundingBox.cgRect),
                pass: .fullImage,
            )
        }
    }

    private static func detectBarcodes(in image: CGImage) async throws -> [TagBarcode] {
        let reads = if usesLatestBarcodeDetector {
            try await detectBarcodesWithLatestRevision(in: image)
        } else {
            try await detectBarcodesWithSimulatorRevision(in: image)
        }
        var barcodes: [TagBarcode] = []
        for read in reads where !read.payload.isEmpty {
            // Vision can report one symbol more than once; keep the first.
            guard !barcodes.contains(where: { $0.symbology == read.symbology && $0.payload == read.payload }) else {
                continue
            }
            barcodes.append(read)
        }
        return barcodes
    }

    /// The simulator cannot run the current barcode detector (revision 4 fails with "Failed to
    /// create barcode detector", and revision 3 finds nothing), so there the reader falls back to
    /// revision 2 on the CPU. Devices always use the current revision.
    static let usesLatestBarcodeDetector: Bool = {
        #if targetEnvironment(simulator)
            false
        #else
            true
        #endif
    }()

    private static func detectBarcodesWithLatestRevision(in image: CGImage) async throws -> [TagBarcode] {
        var request = DetectBarcodesRequest()
        request.symbologies = symbologies.map(\.0)
        return try await perform { try await request.perform(on: image) }.compactMap { observation in
            guard
                let payload = observation.payloadString,
                let symbology = symbologies.first(where: { $0.0 == observation.symbology })?.1
            else { return nil }
            return TagBarcode(
                symbology: symbology,
                payload: payload,
                boundingBox: photoRect(observation.boundingBox.cgRect),
            )
        }
    }

    private static func detectBarcodesWithSimulatorRevision(in image: CGImage) async throws -> [TagBarcode] {
        let legacySymbologies: [VNBarcodeSymbology: TagBarcode.Symbology] = [
            .ean13: .ean13, .ean8: .ean8, .upce: .upce, .code128: .code128, .qr: .qr,
        ]
        let request = VNDetectBarcodesRequest()
        request.revision = VNDetectBarcodesRequestRevision2
        request.symbologies = Array(legacySymbologies.keys)
        if let cpu = try request.supportedComputeStageDevices[.main]?.first(where: { device in
            if case .cpu = device {
                true
            } else {
                false
            }
        }) {
            request.setComputeDevice(cpu, for: .main)
        }
        try await perform { try VNImageRequestHandler(cgImage: image).perform([request]) }
        return (request.results ?? []).compactMap { observation in
            guard let payload = observation.payloadStringValue, let symbology = legacySymbologies[observation.symbology]
            else { return nil }
            return TagBarcode(symbology: symbology, payload: payload, boundingBox: photoRect(observation.boundingBox))
        }
    }

    private func readSizeTabs(in image: CGImage, fullImageLines: [TagTextLine]) async throws -> [TagTextLine] {
        var candidates: [SizeTabPass.Candidate] = []
        for (index, tile) in SizeTabPass.tiles(width: image.width, height: image.height).enumerated() {
            try Task.checkCancellation()
            guard let crop = image.cropping(to: tile).flatMap(SizeTabPass.downscaled) else { continue }
            for observation in try await Self.recognize(crop) {
                guard
                    let candidate = observation.topCandidates(1).first,
                    let token = SizeTabPass.token(from: LatinFolding.fold(candidate.string))
                else { continue }
                candidates.append(SizeTabPass.Candidate(
                    text: token,
                    confidence: Double(candidate.confidence),
                    boundingBox: Self.photoRect(observation.boundingBox.cgRect, inTile: tile, of: image),
                ))
            }
            onStage?(.sizeTabTileFinished(index))
        }
        return SizeTabPass.select(candidates, fullImageLines: fullImageLines)
    }

    // MARK: - Vision

    private static func recognize(_ image: CGImage) async throws -> [RecognizedTextObservation] {
        var request = RecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.automaticallyDetectsLanguage = false
        request.recognitionLanguages = recognitionLanguages
        return try await perform { try await request.perform(on: image) }
    }

    /// Runs a Vision request, passing cancellation through and wrapping Vision's own errors.
    private static func perform<Result>(_ body: () async throws -> Result) async throws -> Result {
        do {
            return try await body()
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            try Task.checkCancellation()
            throw TagReadingError.recognitionFailed(String(describing: error))
        }
    }

    private static func measure<Result>(
        _ clock: ContinuousClock,
        _ body: () async throws -> Result,
    ) async throws -> (Result, Duration) {
        let start = clock.now
        let result = try await body()
        return (result, clock.now - start)
    }

    // MARK: - Geometry

    /// Converts a Vision box (normalized, bottom-left origin) to a top-left ``PhotoRect``.
    static func photoRect(_ box: CGRect) -> PhotoRect {
        PhotoRect(x: box.minX, y: 1 - box.maxY, width: box.width, height: box.height)
    }

    /// Converts a Vision box inside a tile to a ``PhotoRect`` of the whole image.
    static func photoRect(_ box: CGRect, inTile tile: CGRect, of image: CGImage) -> PhotoRect {
        let width = Double(image.width)
        let height = Double(image.height)
        let inTile = photoRect(box)
        return PhotoRect(
            x: (tile.minX + inTile.x * tile.width) / width,
            y: (tile.minY + inTile.y * tile.height) / height,
            width: inTile.width * tile.width / width,
            height: inTile.height * tile.height / height,
        )
    }
}
