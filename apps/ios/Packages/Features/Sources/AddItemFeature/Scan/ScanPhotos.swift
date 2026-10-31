import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// A scan shot's upload-sized photo (``PhotoPreparation``), on disk until the item is kept or
/// the run ends, so a long run never holds every photo in memory.
struct StoredScanPhoto: Equatable, Sendable {
    let file: URL
    let width: Int
    let height: Int
    let sha256: String
    let sharpness: Double

    /// The draft's photo, read back from disk.
    func preparedPhoto() throws -> PreparedPhoto {
        try PreparedPhoto(
            data: Data(contentsOf: file),
            width: width,
            height: height,
            sha256: sha256,
            sharpness: sharpness,
        )
    }
}

/// A scan shot is prepared twice from the camera's capture: a small JPEG the scan sends inline
/// (``scanLongEdge`` pixels) at once, and, while it is read, the upload-sized photo a kept
/// item's draft gets. Both are upright, with no metadata, so no GPS location. Both run off the
/// main actor.
enum ScanPhotos {
    /// The scan's image: big enough to read a tag in hand, small enough to send in a moment on
    /// cellular (about 150 KB).
    static let scanLongEdge = 1024
    static let scanJPEGQuality = 0.7

    /// The draft's photo of a capture, written to `directory`.
    static func store(_ capture: Data, in directory: URL) throws -> StoredScanPhoto {
        let photo = try PhotoPreparation.prepare(capture)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appending(path: "\(UUID().uuidString.lowercased()).jpg")
        try photo.data.write(to: file, options: .completeFileProtectionUntilFirstUserAuthentication)
        return StoredScanPhoto(
            file: file,
            width: photo.width,
            height: photo.height,
            sha256: photo.sha256,
            sharpness: photo.sharpness,
        )
    }

    /// The capture as an upright JPEG of at most ``scanLongEdge`` pixels, with no metadata.
    static func small(_ capture: Data) throws(PhotoPreparationError) -> Data {
        guard let source = CGImageSourceCreateWithData(
            capture as CFData,
            [kCGImageSourceShouldCache: false] as CFDictionary,
        )
        else { throw .unreadableImage }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: scanLongEdge,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw .unreadableImage
        }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil)
        else { throw .encodingFailed }
        CGImageDestinationAddImage(
            destination,
            image,
            [kCGImageDestinationLossyCompressionQuality: scanJPEGQuality] as CFDictionary,
        )
        guard CGImageDestinationFinalize(destination) else { throw .encodingFailed }
        return output as Data
    }
}
