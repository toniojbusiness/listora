import Foundation
import Testing
import UIKit
@testable import DesignSystem

struct RemoteImageTests {
    @Test
    func `decodes at the smallest long edge that still fills the frame`() {
        let fill = RemoteImageLoader.fillLongEdge
        // A 4:3 thumbnail in a 216 px square fills it at 288 x 216.
        #expect(fill(400, 300, 216, 216) == 288)
        // A portrait listing photo across a wide frame fills it by its width.
        #expect(fill(1200, 1600, 1170, 600) == 1560)
        // Never larger than the photo itself.
        #expect(fill(400, 300, 1170, 1170) == 400)
    }

    @Test
    func `loads a photo once at its display size and serves it from memory after`() async throws {
        let url = try Self.writeJPEG(width: 400, height: 300)
        defer { try? FileManager.default.removeItem(at: url) }
        let loader = RemoteImageLoader(configuration: .ephemeral)
        let request = RemoteImageRequest(url: url, pixelWidth: 216, pixelHeight: 216)
        #expect(loader.cachedImage(for: request) == nil)

        let image = try #require(await loader.image(for: request))
        #expect(image.cgImage?.width == 288)
        #expect(image.cgImage?.height == 216)

        // The file is gone, so only the memory cache can answer.
        try FileManager.default.removeItem(at: url)
        #expect(loader.cachedImage(for: request) === image)
        #expect(await loader.image(for: request) === image)
    }

    @Test
    func `a photo that cannot be read leaves the placeholder`() async throws {
        let url = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).jpg")
        try Data("not an image".utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let loader = RemoteImageLoader(configuration: .ephemeral)
        #expect(await loader.image(for: RemoteImageRequest(url: url, pixelWidth: 100, pixelHeight: 100)) == nil)
    }

    @Test
    func `a photo is downloaded once at a time, however many views ask for it`() async throws {
        let url = try #require(URL(string: "https://photos.listora.test/\(UUID().uuidString)/thumbnail.jpg"))
        let jpeg = try Data(contentsOf: Self.writeJPEG(width: 400, height: 300))
        CountingPhotoServer.serve(jpeg, at: url)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CountingPhotoServer.self]
        let loader = RemoteImageLoader(configuration: configuration)

        // The server holds the photo, so the prefetch is still on the way when the views ask.
        CountingPhotoServer.hold(url)
        loader.prefetch([url])
        let first = loader.download(url, priority: .userInitiated)
        let second = loader.download(url, priority: .userInitiated)
        CountingPhotoServer.release(url)
        #expect(await first.value == jpeg)
        #expect(await second.value == jpeg)
        #expect(CountingPhotoServer.requests(for: url) == 1)
    }

    private static func writeJPEG(width: Int, height: Int) throws -> URL {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            return format
        }())
        let image = renderer.image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
        let url = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).jpg")
        try #require(image.jpegData(compressionQuality: 0.8)).write(to: url)
        return url
    }
}

/// Serves photos from memory and counts the requests for each, standing in for the photo CDN. A
/// held photo is answered only when released.
private final class CountingPhotoServer: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var photos: [URL: Data] = [:]
    nonisolated(unsafe) private static var counts: [URL: Int] = [:]
    nonisolated(unsafe) private static var held: [URL: [CountingPhotoServer]] = [:]

    static func serve(_ data: Data, at url: URL) {
        lock.withLock { photos[url] = data }
    }

    static func requests(for url: URL) -> Int {
        lock.withLock { counts[url] ?? 0 }
    }

    static func hold(_ url: URL) {
        lock.withLock { held[url] = [] }
    }

    static func release(_ url: URL) {
        let waiting = lock.withLock { held.removeValue(forKey: url) ?? [] }
        for load in waiting {
            load.answer()
        }
    }

    override static func canInit(with request: URLRequest) -> Bool {
        request.url?.host() == "photos.listora.test"
    }

    override static func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let url = request.url else { return }
        let isHeld = Self.lock.withLock {
            Self.counts[url, default: 0] += 1
            guard Self.held[url] != nil else { return false }
            Self.held[url]?.append(self)
            return true
        }
        if !isHeld {
            answer()
        }
    }

    override func stopLoading() {}

    private func answer() {
        guard let url = request.url else { return }
        let data = Self.lock.withLock { Self.photos[url] }
        if let response = HTTPURLResponse(
            url: url,
            statusCode: data == nil ? 404 : 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "image/jpeg"],
        ) {
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        }
        client?.urlProtocol(self, didLoad: data ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }
}
