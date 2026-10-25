import ImageIO
import SwiftUI
import UIKit

/// One photo at the pixel size it fills on screen.
public struct RemoteImageRequest: Hashable, Sendable {
    public let url: URL
    public let pixelWidth: Int
    public let pixelHeight: Int

    public init(url: URL, pixelWidth: Int, pixelHeight: Int) {
        self.url = url
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
    }
}

/// Loads the photos the server hosts (thumbnails, listing photos) for lists and screens: fetched
/// through a disk cache sized for a large inventory, decoded off the main actor at the size they
/// fill, and kept in memory, so a row scrolled back into view shows its photo in the same frame
/// instead of downloading and decoding it again. Public photo URLs are immutable (a reprocessed
/// photo gets new ones), so a cached copy is always the right one.
/// Unchecked: its only state is an NSCache and a URLSession, both thread-safe.
public final class RemoteImageLoader: @unchecked Sendable {
    public static let shared = RemoteImageLoader()

    private let session: URLSession
    private let memory = NSCache<NSString, UIImage>()

    public init(configuration: URLSessionConfiguration = RemoteImageLoader.defaultConfiguration()) {
        session = URLSession(configuration: configuration)
        // Decoded bytes: about 250 inventory thumbnails at 3x, or a dozen full-width photos.
        memory.totalCostLimit = 48 * 1024 * 1024
    }

    /// The shared URLCache's default 10 MB of disk holds a few hundred thumbnails; this one holds
    /// every thumbnail of a 2,000-item inventory (about 30 KB each) and the recent listing photos.
    public static func defaultConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.default
        let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appending(path: "RemoteImages", directoryHint: .isDirectory)
        configuration.urlCache = URLCache(
            memoryCapacity: 4 * 1024 * 1024,
            diskCapacity: 200 * 1024 * 1024,
            directory: directory,
        )
        // The URLs never change content, so a cached response is used whatever its age.
        configuration.requestCachePolicy = .returnCacheDataElseLoad
        return configuration
    }

    /// The image already decoded for `request`, if any, so a view can show it in its first frame.
    public func cachedImage(for request: RemoteImageRequest) -> UIImage? {
        memory.object(forKey: Self.key(request))
    }

    /// The photo decoded to fill `request`'s size; nil when it cannot be fetched or decoded (the
    /// view keeps its placeholder, and asks again the next time it appears).
    public func image(for request: RemoteImageRequest) async -> UIImage? {
        if let cached = cachedImage(for: request) {
            return cached
        }
        guard let (data, response) = try? await session.data(from: request.url) else { return nil }
        if let http = response as? HTTPURLResponse, !(200 ..< 300).contains(http.statusCode) {
            return nil
        }
        let image = await Task.detached(priority: .userInitiated) {
            Self.decode(data, filling: request)
        }.value
        if let image, let cgImage = image.cgImage {
            memory.setObject(image, forKey: Self.key(request), cost: cgImage.bytesPerRow * cgImage.height)
        }
        return image
    }

    /// Decodes at the smallest size that still fills `request` (never larger than the photo).
    static func decode(_ data: Data, filling request: RemoteImageRequest) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0
        else {
            return nil
        }
        let longEdge = fillLongEdge(
            imageWidth: width,
            imageHeight: height,
            targetWidth: request.pixelWidth,
            targetHeight: request.pixelHeight,
        )
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: longEdge,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }

    /// The long edge, in pixels, at which an image covers the target when scaled to fill it.
    static func fillLongEdge(imageWidth: Int, imageHeight: Int, targetWidth: Int, targetHeight: Int) -> Int {
        let scale = max(Double(targetWidth) / Double(imageWidth), Double(targetHeight) / Double(imageHeight))
        let longEdge = Int((Double(max(imageWidth, imageHeight)) * scale).rounded(.up))
        return min(max(longEdge, 1), max(imageWidth, imageHeight))
    }

    private static func key(_ request: RemoteImageRequest) -> NSString {
        "\(request.url.absoluteString)#\(request.pixelWidth)x\(request.pixelHeight)" as NSString
    }
}

/// A photo from the server, filling exactly the space it is given (like a color) and clipped to
/// it, with `placeholder` while it loads or when there is none. Use it instead of `AsyncImage`,
/// which keeps no decoded copy and downloads a photo again each time its row comes back.
public struct RemoteImage<Placeholder: View>: View {
    private let url: URL?
    private let loader: RemoteImageLoader
    private let placeholder: Placeholder
    @State private var loaded: (request: RemoteImageRequest, image: UIImage)?
    @Environment(\.displayScale) private var displayScale

    public init(
        url: URL?,
        loader: RemoteImageLoader = .shared,
        @ViewBuilder placeholder: () -> Placeholder,
    ) {
        self.url = url
        self.loader = loader
        self.placeholder = placeholder()
    }

    public var body: some View {
        Color.clear
            .overlay {
                GeometryReader { proxy in
                    content(size: proxy.size)
                }
            }
            .clipped()
    }

    private func content(size: CGSize) -> some View {
        let request = url.map {
            RemoteImageRequest(
                url: $0,
                pixelWidth: Int((size.width * displayScale).rounded(.up)),
                pixelHeight: Int((size.height * displayScale).rounded(.up)),
            )
        }
        let image = request.flatMap { request in
            loaded?.request == request ? loaded?.image : loader.cachedImage(for: request)
        }
        return ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                placeholder
            }
        }
        .frame(width: size.width, height: size.height)
        // A frame measured as zero on the first layout loads nothing; the real size loads again.
        .task(id: request) {
            guard let request, request.pixelWidth > 0, request.pixelHeight > 0, image == nil else { return }
            if let fetched = await loader.image(for: request), !Task.isCancelled {
                loaded = (request, fetched)
            }
        }
    }
}
