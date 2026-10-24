import Foundation

/// Reads the text and barcodes on a tag or label photo, on the device.
///
/// `TagReadingFeature` provides the Vision implementation (`VisionTagReader`); `AppFeature`
/// injects it, so a feature that captures photos depends only on this protocol.
public protocol TagReader: Sendable {
    /// Reads one encoded photo (JPEG, HEIC, or PNG), honoring its EXIF orientation.
    ///
    /// Runs off the main actor. Throws `CancellationError` when the calling task is cancelled and
    /// ``TagReadingError`` when the photo cannot be read. A photo without text or barcodes is not
    /// an error: it returns an empty reading.
    func read(imageData: Data) async throws -> TagReading
}

public enum TagReadingError: Error, Equatable {
    /// The data is not an image the device can decode.
    case unreadableImage
    /// Vision failed on a decodable image. The description is Vision's, for diagnostics.
    case recognitionFailed(String)
}
