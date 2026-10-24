import DesignSystem
import ImageIO
import SwiftUI
import UIKit

/// Decodes photo files at display size off the main actor and keeps recent ones in memory.
/// Unchecked: its only state is an NSCache, which is thread-safe.
final class ThumbnailCache: @unchecked Sendable {
    static let shared = ThumbnailCache()

    private let cache = NSCache<NSString, UIImage>()

    init() {
        cache.countLimit = 200
    }

    func image(at url: URL, maxPixelSize: Int) async -> UIImage? {
        let key = "\(url.path(percentEncoded: false))#\(maxPixelSize)" as NSString
        if let cached = cache.object(forKey: key) {
            return cached
        }
        let image = await Task.detached(priority: .userInitiated) {
            Self.decode(url, maxPixelSize: maxPixelSize)
        }.value
        if let image {
            cache.setObject(image, forKey: key)
        }
        return image
    }

    private static func decode(_ url: URL, maxPixelSize: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

/// A draft photo filling its frame, loaded at the size shown.
struct PhotoThumbnail: View {
    let url: URL
    /// Longest edge in points; pixels follow the screen scale.
    let pointSize: CGFloat
    var contentMode: ContentMode = .fill
    @State private var image: UIImage?
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        ZStack {
            Palette.surfaceSecondary.color
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            } else {
                ProgressView()
            }
        }
        // Reloads when the size changes: a frame measured as zero on the first layout must not leave
        // a tiny, blurry image on screen.
        .task(id: ThumbnailRequest(url: url, maxPixelSize: Int((pointSize * displayScale).rounded(.up)))) {
            let size = Int((pointSize * displayScale).rounded(.up))
            guard size > 0 else { return }
            image = await ThumbnailCache.shared.image(at: url, maxPixelSize: size)
        }
    }
}

private struct ThumbnailRequest: Hashable {
    let url: URL
    let maxPixelSize: Int
}
