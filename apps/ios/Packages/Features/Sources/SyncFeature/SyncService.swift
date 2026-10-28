import APIClient
import Foundation
import ListoraAPI

/// One linked marketplace's sync, as Listora's server says it (`SyncMarketplace`).
public struct MarketplaceSyncStatus: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        /// A read of the marketplace waits or runs.
        case syncing
        /// The last reads got through.
        case synced
        /// The last read didn't; syncing again tries again.
        case failed
        /// Nothing was read yet (or a state this app doesn't know).
        case notSynced
    }

    /// The marketplace id (`depop`).
    public let marketplace: String
    public let state: State
    /// The server's words, without the marketplace's name ("52 sales found").
    public let statusText: String
    public let lastSyncedAt: Date?

    public init(marketplace: String, state: State, statusText: String, lastSyncedAt: Date? = nil) {
        self.marketplace = marketplace
        self.state = state
        self.statusText = statusText
        self.lastSyncedAt = lastSyncedAt
    }
}

/// The sync's calls (docs/features/sync.md), throwing ``APIFailure`` for every other answer. A
/// protocol so the model's tests run against a fake.
public protocol SyncService: Sendable {
    /// Each linked marketplace's sync.
    func status() async throws(APIFailure) -> [MarketplaceSyncStatus]
    /// Asks for read-only checks of every linked marketplace now; their syncs after the request.
    func requestSync(idempotencyKey: String) async throws(APIFailure) -> [MarketplaceSyncStatus]
}

/// ``SyncService`` over the generated client.
public struct APISyncService: SyncService {
    private let client: Client

    public init(client: Client) {
        self.client = client
    }

    public func status() async throws(APIFailure) -> [MarketplaceSyncStatus] {
        switch try await call({ try await client.getSyncStatus() }) {
        case let .ok(response): try body { try response.body.json }.data.map(Self.status)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    public func requestSync(idempotencyKey: String) async throws(APIFailure) -> [MarketplaceSyncStatus] {
        let output = try await call {
            try await client.requestSync(headers: .init(idempotencyKey: idempotencyKey))
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }.data.map(Self.status)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    static func status(_ row: Components.Schemas.SyncMarketplace) -> MarketplaceSyncStatus {
        let state: MarketplaceSyncStatus.State = switch row.state.value1 {
        case .syncing: .syncing
        case .synced: .synced
        case .failed: .failed
        case .notSynced, nil: .notSynced
        }
        return MarketplaceSyncStatus(
            marketplace: row.marketplace.value1?.rawValue ?? row.marketplace.value2 ?? "",
            state: state,
            statusText: row.statusText,
            lastSyncedAt: row.lastSyncedAt,
        )
    }

    private func call<Output>(_ request: () async throws -> Output) async throws(APIFailure) -> Output {
        do {
            return try await request()
        } catch {
            throw APIFailure(error)
        }
    }

    private func body<Body>(_ read: () throws -> Body) throws(APIFailure) -> Body {
        do {
            return try read()
        } catch {
            throw APIFailure(error)
        }
    }
}
