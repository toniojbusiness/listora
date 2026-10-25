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
    lastOkAt: String? = nil,
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
    if let lastOkAt {
        object["lastOkAt"] = lastOkAt
    }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(
        Components.Schemas.Connection.self,
        from: JSONSerialization.data(withJSONObject: object),
    )
}

/// The banner a test's health summary carries.
struct BannerSpec {
    let tone: String
    let label: String
    let detail: String?
}

/// The health summary the server sends for `connections`, with the banner a test gives it.
func healthSummary(
    _ connections: [Components.Schemas.Connection],
    banner: BannerSpec? = nil,
    attention: Int = 1,
) throws -> Components.Schemas.ConnectionHealthSummary {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    var object: [String: Any] = try [
        "needsAttention": banner != nil,
        "attention": banner == nil ? [] : (0 ..< attention).map { _ in
            [
                "marketplace": "ebay",
                "reason": "reconnect",
                "statusDisplay": ["tone": "action_needed", "label": "Reconnect needed"],
            ]
        },
        "connections": JSONSerialization.jsonObject(with: encoder.encode(connections)),
        "saleForwarding": [
            "status": "needs_domain",
            "statusDisplay": [
                "tone": "neutral",
                "label": "Set up when you add a domain",
                "detail": "It needs Listora's email domain.",
            ],
        ],
    ]
    if let banner {
        object["banner"] = ["tone": banner.tone, "label": banner.label]
            .merging(banner.detail.map { ["detail": $0] } ?? [:]) { $1 }
    }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(
        Components.Schemas.ConnectionHealthSummary.self,
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

/// A scripted ``ConnectionsService`` that records what it was asked. `lists` are the
/// connections each read of the list or the health summary answers in turn (the last one
/// repeats); `banners` the summary's banner for the same reads.
final class FakeConnectionsService: ConnectionsService, @unchecked Sendable {
    private let lock = NSLock()
    private var _lists: [Result<[Components.Schemas.Connection], APIFailure>]
    private var _banners: [BannerSpec?]
    private var _start: Result<Components.Schemas.ConnectionAuthorization, APIFailure>
    private var _check: Result<Components.Schemas.Connection, APIFailure>
    private var _results: [String: Components.Schemas.ConnectionAuthorization]
    private(set) var startedKeys: [String] = []
    private(set) var checkKeys: [String] = []
    private(set) var readIDs: [String] = []
    private(set) var listCalls = 0

    init(
        lists: [Result<[Components.Schemas.Connection], APIFailure>],
        banners: [BannerSpec?] = [nil],
        start: Result<Components.Schemas.ConnectionAuthorization, APIFailure> = .failure(.networkUnavailable),
        check: Result<Components.Schemas.Connection, APIFailure> = .failure(.networkUnavailable),
        results: [String: Components.Schemas.ConnectionAuthorization] = [:],
    ) {
        _lists = lists
        _banners = banners
        _start = start
        _check = check
        _results = results
    }

    func connections() async throws(APIFailure) -> [Components.Schemas.Connection] {
        try next().list.get()
    }

    func health() async throws(APIFailure) -> Components.Schemas.ConnectionHealthSummary {
        let (list, banner) = next()
        let connections = try list.get()
        do {
            return try healthSummary(connections, banner: banner)
        } catch {
            throw APIFailure(error)
        }
    }

    func requestCheck(
        marketplace _: Components.Schemas.KnownMarketplace,
        idempotencyKey: String,
    ) async throws(APIFailure) -> Components.Schemas.Connection {
        let result = lock.withLock {
            checkKeys.append(idempotencyKey)
            return _check
        }
        return try result.get()
    }

    private func next() -> (list: Result<[Components.Schemas.Connection], APIFailure>, banner: BannerSpec?) {
        lock.withLock {
            listCalls += 1
            let list = _lists.count > 1 ? _lists.removeFirst() : _lists[0]
            let banner = _banners.count > 1 ? _banners.removeFirst() : _banners[0]
            return (list, banner)
        }
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
