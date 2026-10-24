import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// A photo ready to upload: an upright JPEG of at most ``PhotoPreparation/maxLongEdge`` pixels on
/// its long edge, with no metadata (so no GPS location), plus what the upload declares about it.
struct PreparedPhoto: Equatable, Sendable {
    let data: Data
    let width: Int
    let height: Int
    /// Lowercase hex SHA-256 of `data`, as `createUploadSession` declares it.
    let sha256: String
    /// Sharpness from ``BlurDetector``; higher is sharper.
    let sharpness: Double

    var looksBlurry: Bool {
        sharpness < BlurDetector.blurryBelow
    }
}

enum PhotoPreparationError: Error, Equatable {
    /// The data is not an image this device can decode.
    case unreadableImage
    case encodingFailed
}

/// Turns a camera capture or a library photo into what the app uploads: the API contract asks
/// clients to resize to at most 2048 px on the long edge, encode JPEG, and strip GPS.
///
/// The image is decoded upright (its EXIF orientation applied), downscaled with ImageIO, and
/// re-encoded without copying any metadata: no EXIF, GPS, TIFF, or maker data survives, only the
/// pixels and their color profile. Everything runs off the main actor.
enum PhotoPreparation {
    static let maxLongEdge = 2048
    static let jpegQuality = 0.85

    static func prepare(_ imageData: Data) throws(PhotoPreparationError) -> PreparedPhoto {
        let image = try decodeUpright(imageData, maxLongEdge: maxLongEdge)
        return try encode(image)
    }

    /// Crops a prepared photo to `rect`, given in normalized coordinates of the upright image
    /// (origin top left, 1 is the full width or height).
    static func crop(_ imageData: Data, to rect: CGRect) throws(PhotoPreparationError) -> PreparedPhoto {
        let image = try decodeUpright(imageData, maxLongEdge: nil)
        let width = CGFloat(image.width)
        let height = CGFloat(image.height)
        let clamped = rect.intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
        let pixels = CGRect(
            x: clamped.minX * width,
            y: clamped.minY * height,
            width: clamped.width * width,
            height: clamped.height * height,
        ).integral
        guard pixels.width >= 1, pixels.height >= 1, let cropped = image.cropping(to: pixels) else {
            throw .encodingFailed
        }
        return try encode(cropped)
    }

    private static func decodeUpright(_ data: Data, maxLongEdge: Int?) throws(PhotoPreparationError) -> CGImage {
        guard let source = CGImageSourceCreateWithData(
                  data as CFData,
                  [kCGImageSourceShouldCache: false] as CFDictionary,
              ),
              CGImageSourceGetCount(source) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let pixelWidth = properties[kCGImagePropertyPixelWidth] as? Int,
              let pixelHeight = properties[kCGImagePropertyPixelHeight] as? Int
        else {
            throw .unreadableImage
        }
        // The thumbnail API applies the EXIF orientation and downsamples while decoding; asking for
        // the full long edge returns the whole image upright.
        let longEdge = max(pixelWidth, pixelHeight)
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: min(longEdge, maxLongEdge ?? longEdge),
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw .unreadableImage
        }
        return image
    }

    private static func encode(_ image: CGImage) throws(PhotoPreparationError) -> PreparedPhoto {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil)
        else {
            throw .encodingFailed
        }
        // Only the compression quality: no source properties are passed, so no metadata is written.
        CGImageDestinationAddImage(
            destination,
            image,
            [kCGImageDestinationLossyCompressionQuality: jpegQuality] as CFDictionary,
        )
        guard CGImageDestinationFinalize(destination) else { throw .encodingFailed }
        let data = output as Data
        return PreparedPhoto(
            data: data,
            width: image.width,
            height: image.height,
            sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(),
            sharpness: BlurDetector.sharpness(of: image),
        )
    }
}
