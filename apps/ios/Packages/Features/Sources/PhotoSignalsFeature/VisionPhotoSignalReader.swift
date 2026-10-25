import Core
import CoreGraphics
import Dispatch
import Foundation
import ImageIO
import Vision

enum PhotoSignalsError: Error, Equatable {
    case unreadableImage
    case visionFailed(String)
}

/// Reads the signals batch grouping needs from one photo, with Apple Vision, entirely on the
/// device (``ShotSignals``): the image's feature print, and how much of it is printed text, which
/// tells a close-up of a tag from a garment.
///
/// Both run on a small copy of the photo: the feature print scales the image down itself, and a
/// tag close-up's text is large. Fast text recognition is enough to count characters; the
/// accurate reading of a tag photo's text is the tag reader's (`TagReadingFeature`).
public struct VisionPhotoSignalReader: PhotoSignalReader {
    /// The long edge photos are read at.
    static let sampleLongEdge = 640
    /// Recognized characters at or below this read as no tag: a print or a logo on a garment.
    static let fewCharacters = 12
    /// Recognized characters at or above this read as surely a tag close-up.
    static let manyCharacters = 40

    public init() {}

    @concurrent
    public func signals(of imageData: Data) async throws -> ShotSignals {
        dispatchPrecondition(condition: .notOnQueue(.main))
        let image = try Self.sample(imageData)
        async let featurePrint = Self.featurePrint(of: image)
        async let characters = Self.characterCount(in: image)
        return try await ShotSignals(
            featurePrint: featurePrint,
            tagLikelihood: Self.tagLikelihood(characters: characters),
        )
    }

    /// 0 at ``fewCharacters`` or fewer, 1 at ``manyCharacters`` or more, linear between.
    static func tagLikelihood(characters: Int) -> Double {
        let span = Double(manyCharacters - fewCharacters)
        return min(1, max(0, Double(characters - fewCharacters) / span))
    }

    private static func sample(_ data: Data) throws(PhotoSignalsError) -> CGImage {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: sampleLongEdge,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) > 0,
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        else { throw .unreadableImage }
        return image
    }

    /// Whether this environment computes feature prints. The simulator does not: its default
    /// compute device fails ("Failed to create espresso context"), and its CPU gives nearly the
    /// same print for any photo, so there the reader reports none and grouping relies on the
    /// other signals. Devices run Vision's own choice of device.
    public static let readsFeaturePrints: Bool = {
        #if targetEnvironment(simulator)
            false
        #else
            true
        #endif
    }()

    private static func featurePrint(of image: CGImage) async throws -> [Float]? {
        guard readsFeaturePrints else { return nil }
        let request = GenerateImageFeaturePrintRequest()
        let observation = try await perform { try await request.perform(on: image) }
        return floats(observation.data, elementType: observation.elementType)
    }

    /// The feature print's elements as floats; nil for an element type added after this build.
    static func floats(_ data: Data, elementType: ElementType) -> [Float]? {
        switch elementType {
        case .float:
            data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
        case .double:
            data.withUnsafeBytes { $0.bindMemory(to: Double.self).map(Float.init) }
        @unknown default:
            nil
        }
    }

    private static func characterCount(in image: CGImage) async throws -> Int {
        var request = RecognizeTextRequest()
        request.recognitionLevel = .fast
        request.usesLanguageCorrection = false
        let observations = try await perform { try await request.perform(on: image) }
        return observations.reduce(0) { count, observation in
            guard let candidate = observation.topCandidates(1).first, candidate.confidence >= 0.3 else { return count }
            return count + candidate.string.count { !$0.isWhitespace }
        }
    }

    /// Runs a Vision request, passing cancellation through and wrapping Vision's own errors.
    private static func perform<Result>(_ body: () async throws -> Result) async throws -> Result {
        do {
            return try await body()
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            try Task.checkCancellation()
            throw PhotoSignalsError.visionFailed(String(describing: error))
        }
    }
}
