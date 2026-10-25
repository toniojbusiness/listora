import APIClient
import Foundation
import ListoraAPI
import MarketplacesFeature

/// A connection as the server sends it, with the parts a test cares about.
func connection(
    marketplace: String = "ebay",
    mode: String = "api",
    status: String,
    tone: String,
    label: String,
    detail: String? = nil,
    connect: String = "oauth",
    actions: [String] = [],
    displayName: String? = nil,
) throws -> Components.Schemas.Connection {
    var object: [String: Any] = [
        "marketplace": marketplace,
        "mode": mode,
        "status": status,
        "statusDisplay": ["tone": tone, "label": label].merging(detail.map { ["detail": $0] } ?? [:]) { $1 },
        "availableActions": actions,
        "capabilities": [
            "connect": connect, "create": mode, "updatePrice": mode, "updateDetails": mode,
            "delist": mode, "relist": mode, "markSold": mode, "verifyRead": mode == "api" ? "api" : "user_confirm",
            "importListings": "none", "saleDetection": ["manual"], "imageTransport": "url_fetch",
        ],
    ]
    if let displayName {
        object["displayName"] = displayName
    }
    return try JSONDecoder().decode(
        Components.Schemas.Connection.self,
        from: JSONSerialization.data(withJSONObject: object),
    )
}

func authorization(
    id: String = "0199a1f0-0000-7000-8000-00000000a001",
    status: String,
    url: String? = "https://auth.ebay.com/oauth2/authorize?state=abc",
    failure: String? = nil,
    connected: Components.Schemas.Connection? = nil,
) throws -> Components.Schemas.ConnectionAuthorization {
    var object: [String: Any] = [
        "id": id,
        "marketplace": "ebay",
        "status": status,
        "callbackUrlScheme": "listora",
        "expiresAt": "2026-10-24T12:10:00Z",
        "createdAt": "2026-10-24T12:00:00Z",
    ]
    if let url {
        object["authorizationUrl"] = url
    }
    if let failure {
        object["failure"] = [
            "code": "marketplace_authorization_denied",
            "message": failure,
            "retryable": true,
            "requestId": "req-1",
        ]
    }
    if let connected {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        object["connection"] = try JSONSerialization.jsonObject(with: encoder.encode(connected))
    }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(
        Components.Schemas.ConnectionAuthorization.self,
        from: JSONSerialization.data(withJSONObject: object),
    )
}

/// A scripted ``ConnectionsService`` that records what it was asked.
final class FakeConnectionsService: ConnectionsService, @unchecked Sendable {
    private let lock = NSLock()
    private var _lists: [Result<[Components.Schemas.Connection], APIFailure>]
    private var _start: Result<Components.Schemas.ConnectionAuthorization, APIFailure>
    private var _results: [String: Components.Schemas.ConnectionAuthorization]
    private(set) var startedKeys: [String] = []
    private(set) var readIDs: [String] = []
    private(set) var listCalls = 0

    init(
        lists: [Result<[Components.Schemas.Connection], APIFailure>],
        start: Result<Components.Schemas.ConnectionAuthorization, APIFailure> = .failure(.networkUnavailable),
        results: [String: Components.Schemas.ConnectionAuthorization] = [:],
    ) {
        _lists = lists
        _start = start
        _results = results
    }

    func connections() async throws(APIFailure) -> [Components.Schemas.Connection] {
        let result = lock.withLock {
            listCalls += 1
            return _lists.count > 1 ? _lists.removeFirst() : _lists[0]
        }
        return try result.get()
    }

    func startAuthorization(
        marketplace _: Components.Schemas.KnownMarketplace,
        idempotencyKey: String,
    ) async throws(APIFailure) -> Components.Schemas.ConnectionAuthorization {
        let result = lock.withLock {
            startedKeys.append(idempotencyKey)
            return _start
        }
        return try result.get()
    }

    func authorization(
        marketplace _: Components.Schemas.KnownMarketplace,
        id: String,
    ) async throws(APIFailure) -> Components.Schemas.ConnectionAuthorization {
        let found = lock.withLock {
            readIDs.append(id)
            return _results[id]
        }
        guard let found else {
            throw APIFailure(statusCode: 404, code: "not_found", message: "Not found.", retryable: false)
        }
        return found
    }
}
