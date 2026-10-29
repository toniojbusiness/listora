import Foundation

/// Each listing photo once (Listora's own listing image, already sized and compressed for
/// marketplaces when it was processed), for every marketplace that posts it: marketplaces
/// running side by side share the one download.
///
/// It fetches only from Listora's own photo hosts (`PhotoSources`: the API, and the media host the
/// build names), follows no redirect, and stops at `maxBytes`: a call can't make the phone fetch
/// anything else, on the internet or on the seller's own network.
@MainActor
final class PhotoCache {
    private var photos: [URL: Task<Photo, any Error>] = [:]
    private var order: [URL] = []
    /// Photos kept at most: a few listings' worth.
    private let limit = 24
    private let sources: PhotoSources

    init(sources: PhotoSources) {
        self.sources = sources
    }

    /// One downloaded photo, as the runtime takes it.
    struct Photo: Sendable {
        let name: String
        let mimeType: String
        let base64: String

        var message: [String: Any] {
            ["name": name, "mimeType": mimeType, "base64": base64]
        }
    }

    func photo(_ url: URL, timeout: Duration) async throws -> [String: Any] {
        guard sources.allows(url) else { throw PageFailure("blocked") }
        if let known = photos[url] {
            do {
                return try await known.value.message
            } catch {
                // A failed download is tried again by the next call that needs it.
                forget(url)
                throw error
            }
        }
        let task = Task<Photo, any Error> { try await Self.fetch(url, timeout: timeout) }
        photos[url] = task
        order.append(url)
        if order.count > limit {
            photos[order.removeFirst()] = nil
        }
        do {
            return try await task.value.message
        } catch {
            forget(url)
            throw error
        }
    }

    func removeAll() {
        photos = [:]
        order = []
    }

    private func forget(_ url: URL) {
        photos[url] = nil
        order.removeAll { $0 == url }
    }

    /// A listing image is a few hundred kilobytes; nothing Listora serves comes near this.
    nonisolated static let maxBytes = 15 * 1024 * 1024

    nonisolated private static func fetch(_ url: URL, timeout: Duration) async throws -> Photo {
        var request = URLRequest(url: url)
        request.timeoutInterval = Double(timeout.components.seconds) + 1
        let (bytes, response) = try await session.bytes(for: request, delegate: NoRedirects.shared)
        // A redirect is refused, so it arrives here as itself, never as the page it named.
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw PageFailure("unreachable")
        }
        guard http.expectedContentLength <= Int64(maxBytes) else { throw PageFailure("blocked") }
        var data = Data()
        data.reserveCapacity(max(0, Int(http.expectedContentLength)))
        for try await byte in bytes {
            data.append(byte)
            if data.count > maxBytes {
                throw PageFailure("blocked")
            }
        }
        guard !data.isEmpty else { throw PageFailure("unreachable") }
        let mimeType = http.mimeType ?? "image/jpeg"
        let name = url.lastPathComponent.hasSuffix(".jpg") ? url.lastPathComponent : "\(url.lastPathComponent).jpg"
        return Photo(name: name, mimeType: mimeType, base64: data.base64EncodedString())
    }

    /// No cookies, cache, or credentials of the app's own: a photo is a public image.
    nonisolated private static let session = URLSession(configuration: .ephemeral)
}

/// Listora's own photo hosts, the only ones the phone fetches a listing's photos from: the API's
/// origin (the local storage driver serves photos there) and the build's media host
/// (`AppConfiguration.mediaBaseURL`, the photo CDN). Plain http only where the build's own URL
/// is (Dev, which `AppConfiguration` alone allows it).
struct PhotoSources: Sendable {
    let origins: Set<String>

    init(_ bases: [URL]) {
        origins = Set(bases.compactMap(\.webOrigin))
    }

    func allows(_ url: URL) -> Bool {
        url.webOrigin.map { origins.contains($0) } ?? false
    }
}

/// Refuses every redirect of a photo download.
private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    static let shared = NoRedirects()

    func urlSession(
        _: URLSession,
        task _: URLSessionTask,
        willPerformHTTPRedirection _: HTTPURLResponse,
        newRequest _: URLRequest,
    ) async -> URLRequest? {
        nil
    }
}

extension URL {
    /// `scheme://host[:port]`, lower-cased, for an http(s) URL with a host; nil for any other.
    var webOrigin: String? {
        guard let scheme = scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = host()?.lowercased(), !host.isEmpty
        else {
            return nil
        }
        return port.map { "\(scheme)://\(host):\($0)" } ?? "\(scheme)://\(host)"
    }
}
