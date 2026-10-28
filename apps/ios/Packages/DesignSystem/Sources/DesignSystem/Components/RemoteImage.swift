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
/// photo gets new ones), so a cached copy is always the right one. A photo is downloaded once at
/// a time: a view that asks while a prefetch of it is on the way waits for that download.
/// Only a photo the server served is kept: an error (a thumbnail asked for just before it was
/// made answers 404) is never cached, so the next view that shows the photo asks again.
/// Unchecked: its state is an NSCache and a URLSession, both thread-safe, and the downloads on
/// the way, behind a lock.
public final class RemoteImageLoader: @unchecked Sendable {
    public static let shared = RemoteImageLoader()

    private let session: URLSession
    private let memory = NSCache<NSString, UIImage>()
    private let lock = NSLock()
    private var downloads: [URL: Task<Data?, Never>] = [:]

    public init(configuration: URLSessionConfiguration = RemoteImageLoader.defaultConfiguration()) {
        session = URLSession(configuration: configuration, delegate: ServedPhotosOnly(), delegateQueue: nil)
        // Decoded bytes: about 250 inventory thumbnails at 3x, or a dozen full-width photos.
        memory.totalCostLimit = 48 * 1024 * 1024
    }

    /// The shared URLCache's default 10 MB of disk holds a few hundred thumbnails; this one holds
    /// every thumbnail of a 2,000-item inventory (about 65 KB each) and the recent listing photos.
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
        guard let data = await download(request.url, priority: .userInitiated).value else { return nil }
        let image = await Task.detached(priority: .userInitiated) {
            Self.decode(data, filling: request)
        }.value
        if let image, let cgImage = image.cgImage {
            memory.setObject(image, forKey: Self.key(request), cost: cgImage.bytesPerRow * cgImage.height)
        }
        return image
    }

    /// Downloads `urls` into the disk cache, so their views show them without waiting for the
    /// network: the thumbnails of a page of items before the seller scrolls to them, or an item's
    /// photos before they are swiped to. Photos already cached or on the way are skipped.
    public func prefetch(_ urls: [URL]) {
        for url in urls where !isOnDisk(url) {
            _ = download(url, priority: .utility)
        }
    }

    /// Whether `url`'s photo is in the disk cache, so loading it needs no network.
    public func isOnDisk(_ url: URL) -> Bool {
        session.configuration.urlCache?.cachedResponse(for: URLRequest(url: url)).map(Self.isServed) ?? false
    }

    /// Whether the server answered with the photo, not an error.
    static func isServed(_ cached: CachedURLResponse) -> Bool {
        guard let http = cached.response as? HTTPURLResponse else { return true }
        return (200 ..< 300).contains(http.statusCode)
    }

    /// The download of `url`: the one on the way, or a new one. Its bytes, or nil when the
    /// photo cannot be fetched (the next request tries again).
    func download(_ url: URL, priority: TaskPriority) -> Task<Data?, Never> {
        lock.withLock {
            if let download = downloads[url] {
                return download
            }
            let download = Task(priority: priority) { [session] () -> Data? in
                // An error an earlier build cached would be answered forever, without the network.
                let request = URLRequest(url: url)
                if let cache = session.configuration.urlCache, let cached = cache.cachedResponse(for: request),
                   !Self.isServed(cached)
                {
                    cache.removeCachedResponse(for: request)
                }
                guard let (data, response) = try? await session.data(for: request) else { return nil }
                if let http = response as? HTTPURLResponse, !(200 ..< 300).contains(http.statusCode) {
                    return nil
                }
                return data
            }
            downloads[url] = download
            Task { [weak self] in
                _ = await download.value
                self?.finished(url)
            }
            return download
        }
    }

    private func finished(_ url: URL) {
        lock.withLock { downloads[url] = nil }
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

/// Keeps only the photos the server served in the disk cache, never its errors.
private final class ServedPhotosOnly: NSObject, URLSessionDataDelegate {
    func urlSession(
        _: URLSession,
        dataTask _: URLSessionDataTask,
        willCacheResponse proposed: CachedURLResponse,
        completionHandler: @escaping @Sendable (CachedURLResponse?) -> Void,
    ) {
        completionHandler(RemoteImageLoader.isServed(proposed) ? proposed : nil)
    }
}

/// A photo from the server, filling exactly the space it is given (like a color) and clipped to
/// it, with `placeholder` while it loads or when there is none. Use it instead of `AsyncImage`,
/// which keeps no decoded copy and downloads a photo again each time its row comes back.
/// `preview` is a smaller copy of the same photo (its thumbnail) to show while a large one
/// downloads, when the list the seller came from has cached it: the photo appears at once and
/// sharpens when the large one arrives. A preview that would need the network is not fetched.
public struct RemoteImage<Placeholder: View>: View {
    private let url: URL?
    private let preview: URL?
    private let loader: RemoteImageLoader
    private let placeholder: Placeholder
    @State private var loaded: (request: RemoteImageRequest, image: UIImage)?
    @State private var previewed: (request: RemoteImageRequest, image: UIImage)?
    @Environment(\.displayScale) private var displayScale

    public init(
        url: URL?,
        preview: URL? = nil,
        loader: RemoteImageLoader = .shared,
        @ViewBuilder placeholder: () -> Placeholder,
    ) {
        self.url = url
        self.preview = preview == url ? nil : preview
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
        let request = request(url, size: size)
        let previewRequest = self.request(preview, size: size)
        let image = request.flatMap { request in
            loaded?.request == request ? loaded?.image : loader.cachedImage(for: request)
        }
        let previewImage = previewRequest.flatMap { request in
            previewed?.request == request ? previewed?.image : loader.cachedImage(for: request)
        }
        return ZStack {
            if let image = image ?? previewImage {
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
            if let previewRequest, previewImage == nil, !loader.isOnDisk(request.url),
               loader.isOnDisk(previewRequest.url)
            {
                async let fetched = loader.image(for: request)
                if let shown = await loader.image(for: previewRequest), !Task.isCancelled {
                    previewed = (previewRequest, shown)
                }
                if let fetched = await fetched, !Task.isCancelled {
                    loaded = (request, fetched)
                }
            } else if let fetched = await loader.image(for: request), !Task.isCancelled {
                loaded = (request, fetched)
            }
        }
    }

    private func request(_ url: URL?, size: CGSize) -> RemoteImageRequest? {
        url.map {
            RemoteImageRequest(
                url: $0,
                pixelWidth: Int((size.width * displayScale).rounded(.up)),
                pixelHeight: Int((size.height * displayScale).rounded(.up)),
            )
        }
    }
}
