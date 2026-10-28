import CryptoKit
import Foundation
import UIKit

/// The package photo as it leaves the phone: a JPEG at most 1600 pixels on its longest side,
/// drawn anew so it carries none of the camera's metadata (no location). The server strips it
/// again (docs/features/pack-check.md, "Package photo").
enum PackPhoto {
    static let maxPixels: CGFloat = 1600

    /// The photo as JPEG data, or nil when it can't be encoded.
    static func jpeg(from image: UIImage) -> Data? {
        let longest = max(image.size.width, image.size.height) * image.scale
        let factor = min(1, maxPixels / max(longest, 1))
        let size = CGSize(
            width: (image.size.width * image.scale * factor).rounded(),
            height: (image.size.height * image.scale * factor).rounded(),
        )
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let drawn = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return drawn.jpegData(compressionQuality: 0.8)
    }

    /// Lowercase hex SHA-256, as an upload session declares it.
    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
