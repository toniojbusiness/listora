import CryptoKit
import Foundation
import Synchronization

/// An in-memory stand-in for the Listora API and its storage, true to the contract where the
/// upload queue depends on it: idempotent POSTs (same key, same answer), upload targets that
/// accept only the signed headers and the declared bytes, attach that needs the bytes to have
/// arrived, and the error model. Tests inject faults per request with ``fail(_:times:with:)``.
final class FakeListoraServer: StubServer {
    struct Photo: Equatable {
        var id: String
        var uploadFileID: String
        var role: String
        var sha256: String
        var ocrLines: [String]
        var barcodes: [String]
    }

    struct Item: Equatable {
        var id: String
        var sku: String
        var photos: [Photo] = []
    }

    struct File {
        var id: String
        var sessionID: String
        var byteSize: Int
        var sha256: String
        var status = "pending"
        var bytes: Data?
        var targetExpiresAt = "2099-01-01T00:00:00.000Z"
    }

    struct Fault {
        let matches: @Sendable (StubRequest) -> Bool
        var remaining: Int
        /// nil: never answer.
        let reply: StubReply?
    }

    struct State {
        let storageHost: String
        var items: [String: Item] = [:]
        var itemOrder: [String] = []
        var files: [String: File] = [:]
        var sessions: [String: [String]] = [:]
        var replays: [String: StubReply] = [:]
        var requests: [StubRequest] = []
        var faults: [Fault] = []
        var nextSKU = 184
    }

    let apiHost = "api-\(UUID().uuidString.lowercased()).test"
    let storageHost = "storage-\(UUID().uuidString.lowercased()).test"
    private let state: Mutex<State>

    var baseURL: URL {
        guard let url = URL(string: "https://\(apiHost)") else { fatalError("Invalid test host") }
        return url
    }

    init() {
        state = Mutex(State(storageHost: storageHost))
        StubURLProtocol.register(self, hosts: [apiHost, storageHost])
    }

    deinit {
        StubURLProtocol.unregister(hosts: [apiHost, storageHost])
    }

    // MARK: Inspecting

    var items: [Item] {
        state.withLock { state in state.itemOrder.compactMap { state.items[$0] } }
    }

    var requests: [StubRequest] {
        state.withLock(\.requests)
    }

    func requests(_ method: String, _ pathPrefix: String) -> [StubRequest] {
        requests.filter { $0.method == method && $0.path.hasPrefix(pathPrefix) }
    }

    /// Bytes stored for a file id.
    func storedBytes(ofFile id: String) -> Data? {
        state.withLock { $0.files[id]?.bytes }
    }

    // MARK: Faults

    /// The next `times` requests matching `matches` get `reply` (nil: no answer at all).
    func fail(_ matches: @escaping @Sendable (StubRequest) -> Bool, times: Int = 1, with reply: StubReply?) {
        state.withLock { $0.faults.append(Fault(matches: matches, remaining: times, reply: reply)) }
    }

    /// Marks a file as uploaded without receiving its bytes through a request, as when a
    /// transfer finished while the app was not running.
    func markUploaded(fileID: String, bytes: Data) {
        state.withLock { state in
            state.files[fileID]?.status = "uploaded"
            state.files[fileID]?.bytes = bytes
        }
    }

    /// Drops every stored `Idempotency-Key` answer, as the server does after 24 hours.
    func forgetIdempotencyKeys() {
        state.withLock { $0.replays = [:] }
    }

    /// Makes a file's upload target expire at `date`, as the server caps it at the session's
    /// expiry.
    func expireTarget(ofFile fileID: String, at date: Date) {
        let expiresAt = date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        state.withLock { $0.files[fileID]?.targetExpiresAt = expiresAt }
    }

    // MARK: Serving

    func reply(to request: StubRequest) -> StubReply? {
        state.withLock { state -> StubReply? in
            state.requests.append(request)
            if let index = state.faults.firstIndex(where: { $0.remaining > 0 && $0.matches(request) }) {
                state.faults[index].remaining -= 1
                return state.faults[index].reply
            }
            if request.url.host() == storageHost {
                return Self.store(request, in: &state)
            }
            if request.method == "POST", let key = request.header("Idempotency-Key") {
                if let replay = state.replays[key] {
                    return replay
                }
                let reply = Self.route(request, in: &state)
                if (200 ..< 300).contains(reply.status) {
                    state.replays[key] = reply
                }
                return reply
            }
            return Self.route(request, in: &state)
        }
    }
}

/// Routes and storage of the fake, one function per endpoint.
extension FakeListoraServer {
    // One case per endpoint; splitting the table would only hide the routes.
    // swiftlint:disable:next cyclomatic_complexity
    fileprivate static func route(_ request: StubRequest, in state: inout State) -> StubReply {
        guard request.header("Authorization")?.hasPrefix("Bearer ") == true else {
            return .error(401, code: "unauthenticated", message: "Sign in again.", retryable: false)
        }
        let parts = request.path.split(separator: "/").map(String.init)
        switch (request.method, parts.count) {
        case ("POST", 2) where parts[1] == "items":
            return createItem(in: &state)
        case ("POST", 2) where parts[1] == "upload-sessions":
            return createSession(request, in: &state)
        case ("GET", 3) where parts[1] == "upload-sessions":
            return session(parts[2], in: state)
        case ("GET", 3) where parts[1] == "items":
            return state.items[parts[2]].map { .json(200, itemJSON($0)) } ?? notFound
        case ("DELETE", 3) where parts[1] == "items":
            return deleteItem(parts[2], in: &state)
        case ("POST", 4) where parts[3] == "photos":
            return attach(request, itemID: parts[2], in: &state)
        case ("PUT", 4) where parts[3] == "photo-order":
            return reorder(request, itemID: parts[2], in: &state)
        case ("PATCH", 5) where parts[3] == "photos":
            return updateRole(request, itemID: parts[2], photoID: parts[4], in: &state)
        case ("DELETE", 5) where parts[3] == "photos":
            return deletePhoto(itemID: parts[2], photoID: parts[4], in: &state)
        default:
            return notFound
        }
    }

    private static let notFound = StubReply.error(404, code: "not_found", message: "Not found.", retryable: false)

    private static func createItem(in state: inout State) -> StubReply {
        let item = Item(id: UUID().uuidString.lowercased(), sku: String(format: "AJ-%06d", state.nextSKU))
        state.nextSKU += 1
        state.items[item.id] = item
        state.itemOrder.append(item.id)
        return .json(201, itemJSON(item))
    }

    private static func createSession(_ request: StubRequest, in state: inout State) -> StubReply {
        guard let body = json(request.body), let files = body["files"] as? [[String: Any]], !files.isEmpty else {
            return .error(422, code: "validation_failed", retryable: false)
        }
        let sessionID = UUID().uuidString.lowercased()
        var ids: [String] = []
        for file in files {
            let id = UUID().uuidString.lowercased()
            state.files[id] = File(
                id: id,
                sessionID: sessionID,
                byteSize: file["byteSize"] as? Int ?? 0,
                sha256: file["sha256"] as? String ?? "",
            )
            ids.append(id)
        }
        state.sessions[sessionID] = ids
        return .json(201, sessionJSON(sessionID, state: state))
    }

    private static func session(_ id: String, in state: State) -> StubReply {
        state.sessions[id] == nil ? notFound : .json(200, sessionJSON(id, state: state))
    }

    /// The storage server: a PUT must carry exactly the signed headers and the declared bytes.
    private static func store(_ request: StubRequest, in state: inout State) -> StubReply {
        let fileID = request.url.lastPathComponent
        guard request.method == "PUT", var file = state.files[fileID] else {
            return StubReply(status: 404)
        }
        let checksum = Data(SHA256.hash(data: request.body)).base64EncodedString()
        guard request.header("Content-Type") == "image/jpeg",
              request.header("x-amz-checksum-sha256") == Data(hex: file.sha256).base64EncodedString()
        else {
            return StubReply(status: 403)
        }
        guard checksum == Data(hex: file.sha256).base64EncodedString(), request.body.count == file.byteSize else {
            return StubReply(status: 400)
        }
        file.status = "uploaded"
        file.bytes = request.body
        state.files[fileID] = file
        return StubReply(status: 200, headers: [:])
    }

    private static func attach(_ request: StubRequest, itemID: String, in state: inout State) -> StubReply {
        guard var item = state.items[itemID] else { return notFound }
        guard let body = json(request.body),
              let fileID = body["uploadFileId"] as? String,
              let role = body["role"] as? String
        else {
            return .error(422, code: "validation_failed", retryable: false)
        }
        guard let file = state.files[fileID] else { return notFound }
        guard item.photos.count < 24 else {
            return .error(422, code: "validation_failed", message: "An item has at most 24 photos.", retryable: false)
        }
        switch file.status {
        case "pending":
            return .error(409, code: "upload_incomplete", message: "Upload it again.", retryable: false)
        case "attached":
            return .error(409, code: "already_exists", message: "Already attached.", retryable: false)
        default:
            break
        }
        state.files[fileID]?.status = "attached"
        let photo = Photo(
            id: UUID().uuidString.lowercased(),
            uploadFileID: fileID,
            role: role,
            sha256: file.sha256,
            ocrLines: (body["ocrLines"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String },
            barcodes: (body["barcodes"] as? [[String: Any]] ?? []).compactMap { $0["payload"] as? String },
        )
        item.photos.append(photo)
        state.items[itemID] = item
        return .json(201, photoJSON(photo, itemID: itemID, position: item.photos.count - 1))
    }

    private static func reorder(_ request: StubRequest, itemID: String, in state: inout State) -> StubReply {
        guard var item = state.items[itemID] else { return notFound }
        guard let ids = json(request.body)?["photoIds"] as? [String],
              Set(ids) == Set(item.photos.map(\.id)), ids.count == item.photos.count
        else {
            return .error(422, code: "validation_failed", retryable: false)
        }
        item.photos = ids.compactMap { id in item.photos.first { $0.id == id } }
        state.items[itemID] = item
        return .json(200, ["data": item.photos.enumerated().map { photoJSON($1, itemID: itemID, position: $0) }])
    }

    private static func updateRole(
        _ request: StubRequest,
        itemID: String,
        photoID: String,
        in state: inout State,
    ) -> StubReply {
        guard var item = state.items[itemID], let index = item.photos.firstIndex(where: { $0.id == photoID }) else {
            return notFound
        }
        guard let role = json(request.body)?["role"] as? String else {
            return .error(422, code: "validation_failed", retryable: false)
        }
        item.photos[index].role = role
        state.items[itemID] = item
        return .json(200, photoJSON(item.photos[index], itemID: itemID, position: index))
    }

    private static func deletePhoto(itemID: String, photoID: String, in state: inout State) -> StubReply {
        guard var item = state.items[itemID], item.photos.contains(where: { $0.id == photoID }) else {
            return notFound
        }
        item.photos.removeAll { $0.id == photoID }
        state.items[itemID] = item
        return StubReply(status: 204, headers: [:])
    }

    private static func deleteItem(_ itemID: String, in state: inout State) -> StubReply {
        guard state.items.removeValue(forKey: itemID) != nil else { return notFound }
        state.itemOrder.removeAll { $0 == itemID }
        return StubReply(status: 204, headers: [:])
    }

    // MARK: JSON

    private static let timestamp = "2026-10-24T12:00:00.000Z"

    private static func json(_ data: Data) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private static func itemJSON(_ item: Item) -> [String: Any] {
        [
            "id": item.id,
            "sku": item.sku,
            "status": "draft",
            "version": 1,
            "details": [String: Any](),
            "photos": item.photos.enumerated().map { photoJSON($1, itemID: item.id, position: $0) },
            "listings": [Any](),
            "createdAt": timestamp,
            "updatedAt": timestamp,
        ]
    }

    private static func photoJSON(_ photo: Photo, itemID: String, position: Int) -> [String: Any] {
        [
            "id": photo.id,
            "itemId": itemID,
            "position": position,
            "role": photo.role,
            "status": "processing",
            "width": 100,
            "height": 100,
            "sha256": photo.sha256,
            "ocrLines": photo.ocrLines.map { ["text": $0, "confidence": 0.9] },
            "barcodes": photo.barcodes.map { ["symbology": "ean13", "payload": $0] },
            "createdAt": timestamp,
        ]
    }

    private static func sessionJSON(_ id: String, state: State) -> [String: Any] {
        let files: [[String: Any]] = (state.sessions[id] ?? []).compactMap { fileID in
            guard let file = state.files[fileID] else { return nil }
            var json: [String: Any] = [
                "id": file.id,
                "status": file.status,
                "contentType": "image/jpeg",
                "byteSize": file.byteSize,
                "sha256": file.sha256,
            ]
            if file.status == "pending" {
                json["upload"] = [
                    "method": "PUT",
                    "url": "https://\(state.storageHost)/uploads/\(file.id)",
                    "headers": [
                        ["name": "Content-Type", "value": "image/jpeg"],
                        ["name": "x-amz-checksum-sha256", "value": Data(hex: file.sha256).base64EncodedString()],
                    ],
                    "expiresAt": file.targetExpiresAt,
                ]
            }
            return json
        }
        return ["id": id, "expiresAt": "2099-01-01T00:00:00.000Z", "files": files, "createdAt": timestamp]
    }
}

extension Data {
    /// Bytes from lowercase hex.
    init(hex: String) {
        var bytes: [UInt8] = []
        var index = hex.startIndex
        while let next = hex.index(index, offsetBy: 2, limitedBy: hex.endIndex), index < hex.endIndex {
            bytes.append(UInt8(hex[index ..< next], radix: 16) ?? 0)
            index = next
        }
        self.init(bytes)
    }
}
