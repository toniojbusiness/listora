import APIClient
import Core
import CoreGraphics
import Foundation
import ImageIO
import Synchronization
import UniformTypeIdentifiers
@testable import AddItemFeature

/// A fresh directory under the temporary directory, removed when the value is released.
final class TemporaryDirectory: Sendable {
    let url: URL

    init() throws {
        url = FileManager.default.temporaryDirectory.appending(
            path: "AddItemTests-\(UUID().uuidString)",
            directoryHint: .isDirectory,
        )
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    deinit {
        try? FileManager.default.removeItem(at: url)
    }
}

enum TestImages {
    /// A JPEG of `width` x `height` with sharp detail, optionally carrying GPS and an EXIF
    /// orientation like a phone camera photo.
    static func jpeg(width: Int, height: Int, gps: Bool = false, orientation: Int? = nil, seed: UInt64 = 1) -> Data {
        let image = pattern(width: width, height: height, seed: seed)
        var properties: [CFString: Any] = [:]
        if gps {
            properties[kCGImagePropertyGPSDictionary] = [
                kCGImagePropertyGPSLatitude: 37.3349,
                kCGImagePropertyGPSLatitudeRef: "N",
                kCGImagePropertyGPSLongitude: 122.0090,
                kCGImagePropertyGPSLongitudeRef: "W",
            ]
            properties[kCGImagePropertyExifDictionary] = [kCGImagePropertyExifLensModel: "Test lens"]
        }
        if let orientation {
            properties[kCGImagePropertyOrientation] = orientation
        }
        return encode(image, properties: properties)
    }

    /// Checkered noise: plenty of edges, so it reads as sharp.
    static func pattern(width: Int, height: Int, seed: UInt64 = 1) -> CGImage {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                  data: nil,
                  width: width,
                  height: height,
                  bitsPerComponent: 8,
                  bytesPerRow: 0,
                  space: space,
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue,
              )
        else { fatalError("Could not create a bitmap context") }
        var random = SplitMix(seed: seed)
        let cell = max(4, min(width, height) / 64)
        for row in stride(from: 0, to: height, by: cell) {
            for column in stride(from: 0, to: width, by: cell) {
                let gray = CGFloat(random.next() % 256) / 255
                context.setFillColor(red: gray, green: 1 - gray, blue: gray / 2, alpha: 1)
                context.fill(CGRect(x: column, y: row, width: cell, height: cell))
            }
        }
        guard let image = context.makeImage() else { fatalError("Could not render the test pattern") }
        return image
    }

    /// A JPEG of one flat gray: nothing in it to lift off a background.
    static func solid(width: Int, height: Int) -> Data {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                  data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue,
              )
        else { fatalError("Could not create a bitmap context") }
        context.setFillColor(red: 0.6, green: 0.6, blue: 0.6, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        guard let image = context.makeImage() else { fatalError("Could not draw the image") }
        return encode(image)
    }

    static func encode(_ image: CGImage, properties: [CFString: Any] = [:]) -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)
        else {
            fatalError("Could not create a JPEG destination")
        }
        var options = properties
        options[kCGImageDestinationLossyCompressionQuality] = 0.9
        CGImageDestinationAddImage(destination, image, options as CFDictionary)
        CGImageDestinationFinalize(destination)
        return data as Data
    }

    static func properties(of data: Data) -> [CFString: Any] {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        else { return [:] }
        return properties
    }

    static func prepared(seed: UInt64 = 1) throws -> PreparedPhoto {
        try PhotoPreparation.prepare(jpeg(width: 64, height: 48, seed: seed))
    }

    private struct SplitMix {
        var state: UInt64

        init(seed: UInt64) {
            state = seed
        }

        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var value = state
            value = (value ^ (value >> 30)) &* 0xBF58_476D_1CE4_E5B9
            value = (value ^ (value >> 27)) &* 0x94D0_49BB_1331_11EB
            return value ^ (value >> 31)
        }
    }
}

/// A tag reader with a fixed answer, counting its calls.
final class FakeTagReader: TagReader {
    static let reading = TagReading(
        lines: [
            TagTextLine(
                text: "ACME",
                confidence: 0.98,
                boundingBox: .init(x: 0, y: 0, width: 1, height: 0.2),
                pass: .fullImage,
            ),
            TagTextLine(
                text: "RN 12345",
                confidence: 0.95,
                boundingBox: .init(x: 0, y: 0.3, width: 1, height: 0.2),
                pass: .fullImage,
            ),
        ],
        barcodes: [TagBarcode(
            symbology: .ean13,
            payload: "0012345678905",
            boundingBox: .init(x: 0, y: 0.6, width: 1, height: 0.3),
        )],
        timing: TagReadingTiming(
            decode: .zero,
            textRecognition: .zero,
            barcodeDetection: .zero,
            sizeTabPass: .zero,
            total: .zero,
        ),
    )

    private let calls = Mutex(0)

    var callCount: Int {
        calls.withLock { $0 }
    }

    func read(imageData _: Data) async throws -> TagReading {
        calls.withLock { $0 += 1 }
        return Self.reading
    }
}

/// A tag reader that takes its time and, like Vision mid-pass, does not stop when cancelled.
struct StubbornTagReader: TagReader {
    let takes: Duration

    func read(imageData _: Data) async throws -> TagReading {
        let seconds = Double(takes.components.seconds) + Double(takes.components.attoseconds) / 1e18
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { continuation.resume() }
        }
        return FakeTagReader.reading
    }
}

/// Retries fast enough for tests, with the same shape as production.
extension RetryPolicy {
    static let test = RetryPolicy(
        maxAttempts: 4,
        baseDelay: .milliseconds(20),
        maxDelay: .milliseconds(80),
        jitter: 1 ... 1,
    )
}

/// A clock that moves on by `step` at every reading, as on a slow machine where time passes
/// between any two of the queue's decisions.
final class SteppingClock: Sendable {
    private let time = Mutex(Date.now)
    private let step: TimeInterval

    init(step: Duration) {
        self.step = step.timeInterval
    }

    func now() -> Date {
        time.withLock { time in
            time = time.addingTimeInterval(step)
            return time
        }
    }
}

/// Polls `condition` until it holds or `timeout` passes.
@MainActor
func eventually(
    timeout: Duration = .seconds(15),
    _ condition: @MainActor () async throws -> Bool,
) async throws -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if try await condition() {
            return true
        }
        try await Task.sleep(for: .milliseconds(20))
    }
    return try await condition()
}
