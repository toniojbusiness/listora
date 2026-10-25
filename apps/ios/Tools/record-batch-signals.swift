// Records the grouping signals of the synthetic haul photos (`generate-batch-fixtures.swift`) with
// Apple Vision on this Mac, for the grouping tests in CoreTests, which then run anywhere: the
// simulator cannot compute feature prints (docs/features/batch.md). Run it with
// `make ios-batch-fixtures`, after the photos are rendered.
//
// It reads each photo the way `VisionPhotoSignalReader` does on an iPhone: a 640 px copy, Vision's
// image feature print (the same revision as on iOS), and the characters of fast text recognition,
// mapped to a tag likelihood with the reader's thresholds (keep them in step).

import CoreGraphics
import Foundation
import ImageIO
import Vision

/// `VisionPhotoSignalReader.fewCharacters` and `manyCharacters`.
let fewCharacters = 12
let manyCharacters = 40

struct ManifestEntry: Decodable {
    let sequence: String
    let purpose: String
    let files: [String]
    let items: [Int]
}

struct RecordedShot: Encodable {
    let file: String
    /// The feature print as little-endian Float32 values, base64.
    let featurePrint: String
    let tagLikelihood: Double
}

struct RecordedSequence: Encodable {
    let sequence: String
    let purpose: String
    let items: [Int]
    let shots: [RecordedShot]
}

func sample(_ url: URL) throws -> CGImage {
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 640,
    ]
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    else { throw CocoaError(.fileReadCorruptFile) }
    return image
}

func floats(_ observation: FeaturePrintObservation) -> [Float] {
    switch observation.elementType {
    case .float: observation.data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    case .double: observation.data.withUnsafeBytes { $0.bindMemory(to: Double.self).map(Float.init) }
    @unknown default: []
    }
}

func record(_ url: URL) async throws -> RecordedShot {
    let image = try sample(url)
    let print = try await floats(GenerateImageFeaturePrintRequest().perform(on: image))
    var text = RecognizeTextRequest()
    text.recognitionLevel = .fast
    text.usesLanguageCorrection = false
    let characters = try await text.perform(on: image).reduce(0) { count, observation in
        guard let candidate = observation.topCandidates(1).first, candidate.confidence >= 0.3 else { return count }
        return count + candidate.string.count { !$0.isWhitespace }
    }
    let likelihood = min(1, max(0, Double(characters - fewCharacters) / Double(manyCharacters - fewCharacters)))
    let data = print.withUnsafeBufferPointer { Data(buffer: $0) }
    return RecordedShot(
        file: url.lastPathComponent,
        featurePrint: data.base64EncodedString(),
        tagLikelihood: likelihood,
    )
}

@main
enum RecordBatchSignals {
    static func main() async throws {
        let ios = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appending(path: "..", directoryHint: .isDirectory)
        let photos = ios.appending(
            path: "Packages/Features/Tests/PhotoSignalsFeatureTests/Fixtures",
            directoryHint: .isDirectory,
        )
        let output = ios.appending(path: "Packages/Core/Tests/CoreTests/Fixtures", directoryHint: .isDirectory)
        let manifest = try JSONDecoder().decode(
            [ManifestEntry].self,
            from: Data(contentsOf: photos.appending(path: "manifest.json")),
        )
        var recorded: [RecordedSequence] = []
        for entry in manifest {
            var shots: [RecordedShot] = []
            for file in entry.files {
                try await shots.append(record(photos.appending(path: "\(entry.sequence)/\(file)")))
            }
            recorded.append(RecordedSequence(
                sequence: entry.sequence,
                purpose: entry.purpose,
                items: entry.items,
                shots: shots,
            ))
        }
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(recorded).write(to: output.appending(path: "batch-signals.json"))
        print("Recorded \(recorded.count) sequences to \(output.path)")
    }
}
