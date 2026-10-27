import Foundation

/// Each listing photo once (Listora's own listing image, already sized and compressed for
/// marketplaces when it was processed), for every marketplace that posts it: marketplaces
/// running side by side share the one download. Over HTTPS (HTTP only for a local development
/// host).
@MainActor
final class PhotoCache {
    private var photos: [URL: Task<Photo, any Error>] = [:]
    private var order: [URL] = []
    /// Photos kept at most: a few listings' worth.
    private let limit = 24

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

    nonisolated private static func fetch(_ url: URL, timeout: Duration) async throws -> Photo {
        let local = url.host == "127.0.0.1" || url.host == "localhost"
        guard url.scheme == "https" || (local && url.scheme == "http") else {
            throw PageFailure("blocked")
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = Double(timeout.components.seconds) + 1
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, !data.isEmpty else {
            throw PageFailure("unreachable")
        }
        let mimeType = http.mimeType ?? "image/jpeg"
        let name = url.lastPathComponent.hasSuffix(".jpg") ? url.lastPathComponent : "\(url.lastPathComponent).jpg"
        return Photo(name: name, mimeType: mimeType, base64: data.base64EncodedString())
    }
}
