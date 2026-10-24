import Core
import CoreGraphics
import Foundation
import ImageIO

/// Decodes an encoded photo into an upright bitmap, so every pass and every bounding box works in
/// the orientation the user sees.
enum UprightImage {
    /// The long edge of the decoded bitmap is capped here. It keeps a 48 MP photo from costing
    /// hundreds of megabytes while staying above the 4032 px of a standard 12 MP photo, so tag
    /// text keeps its full resolution.
    static let maxPixelSize = 4096

    static func decode(_ data: Data) throws(TagReadingError) -> CGImage {
        guard
            let source = CGImageSourceCreateWithData(data as CFData, nil),
            CGImageSourceGetCount(source) > 0,
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
            let width = properties[kCGImagePropertyPixelWidth] as? Int,
            let height = properties[kCGImagePropertyPixelHeight] as? Int,
            width > 0, height > 0
        else { throw .unreadableImage }
        // The thumbnail API applies the EXIF orientation and downsamples in one step; at the
        // photo's own size it decodes at full resolution.
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: min(max(width, height), maxPixelSize),
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw .unreadableImage
        }
        return image
    }
}
