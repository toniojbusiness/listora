import APIClient
import Foundation
import ListoraAPI
import Observation

/// The item screen: details, photos, cost and profit, and one row per marketplace with its
/// listing's status and history. Every action is queued with the server's operation engine;
/// the screen then reads the server until the change is settled, so a status changes only when
/// the server's does ("Delisting... retry 2 of 6", "Delist failed - Retry", "Delisted
/// (confirmed by eBay)").
@MainActor
@Observable
final class ItemDetailModel {
    enum Phase: Equatable {
        case loading
        case loaded
        case failed(message: String)
    }

    let itemID: String
    private(set) var item: Item?
    private(set) var phase: Phase = .loading
    private(set) var rows: [MarketplaceRowState] = []
    /// Each listing's operations, newest first.
    private(set) var histories: [String: [Operation]] = [:]
    /// The events of the operations whose history the seller opened.
    private(set) var events: [String: [OperationEvent]] = [:]
    /// The marketplace whose action is being sent right now.
    private(set) var busyMarketplace: String?
    /// The last action's failure to reach the server, safe to show.
    var notice: String?

    private var connections: [Connection] = []
    private let service: any InventoryService
    private let timing: DetailTiming

    init(itemID: String, service: any InventoryService, timing: DetailTiming = .standard) {
        self.itemID = itemID
        self.service = service
        self.timing = timing
    }

    /// True while a listing's change is still running or waiting, so its status will change.
    var isWorking: Bool {
        rows.contains(where: \.isWorking)
    }

    func load() async {
        if item == nil {
            phase = .loading
        }
        do {
            let loaded = try await service.item(id: itemID)
            if let connections = try? await service.connections() {
                self.connections = connections
            }
            await apply(loaded)
            phase = .loaded
        } catch {
            if item == nil {
                phase = .failed(message: error.message)
            }
        }
    }

    /// Reads the item again while a change is in progress, until none is. A retry waits until
    /// its next attempt is due (at most ``DetailTiming/longestPoll``).
    func followChanges() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: pollDelay())
            guard !Task.isCancelled else { return }
            if isWorking {
                await refresh()
            }
        }
    }

    /// The item and its listings' histories, without the loading state.
    func refresh() async {
        guard let loaded = try? await service.item(id: itemID) else { return }
        await apply(loaded)
    }

    func perform(_ request: ListingRequest, marketplace: String) async {
        await run(marketplace: marketplace) { [service] key throws(APIFailure) in
            _ = try await service.perform(request, idempotencyKey: key)
        }
    }

    func retry(operationID: String, marketplace: String) async {
        await run(marketplace: marketplace) { [service] key throws(APIFailure) in
            _ = try await service.retry(operationID: operationID, idempotencyKey: key)
        }
    }

    /// Loads an operation's events the first time its history is opened, and again while it runs.
    func loadEvents(operationID: String) async {
        if let events = try? await service.events(operationID: operationID) {
            self.events[operationID] = events
        }
    }

    // MARK: Private

    /// Sends one action with its own Idempotency-Key, retried with the same key when the answer
    /// is lost, then reads the item back so the row shows the server's status.
    private func run(
        marketplace: String,
        _ send: @escaping @Sendable (String) async throws(APIFailure) -> Void,
    ) async {
        guard busyMarketplace == nil else { return }
        busyMarketplace = marketplace
        notice = nil
        defer { busyMarketplace = nil }
        let key = UUID().uuidString
        var attempt = 0
        while true {
            do {
                try await send(key)
                break
            } catch {
                attempt += 1
                if error.statusCode == nil, error.retryable, attempt < timing.sendAttempts {
                    try? await Task.sleep(for: timing.sendRetryDelay)
                    continue
                }
                notice = error.message
                break
            }
        }
        await refresh()
    }

    private func apply(_ loaded: Item) async {
        item = loaded
        rows = KnownMarketplace.allCases.map { marketplace in
            MarketplaceRowState(
                marketplace: marketplace,
                listing: loaded.listings.first { $0.marketplace.value1 == marketplace },
                connection: connections.first { $0.marketplace.value1 == marketplace },
            )
        }
        for row in rows {
            guard let listing = row.listing, listing.latestOperation != nil else { continue }
            if let operations = try? await service.operations(listingID: listing.id) {
                histories[listing.id] = operations
            }
        }
        for operationID in events.keys {
            await loadEvents(operationID: operationID)
        }
    }

    private func pollDelay() -> Duration {
        let retryAt = rows.compactMap { row -> Date? in
            guard let operation = row.latestOperation, operation.status.value1 == .retrying else { return nil }
            return operation.nextAttemptAt
        }.min()
        guard let retryAt, rows.allSatisfy({ !$0.isWorking || $0.latestOperation?.status.value1 == .retrying })
        else { return timing.poll }
        let wait = retryAt.timeIntervalSinceNow
        return .milliseconds(Int(min(max(wait, timing.poll.seconds), timing.longestPoll.seconds) * 1000))
    }
}

/// How often the item screen reads the server while a change runs.
struct DetailTiming: Sendable {
    var poll: Duration
    /// The longest wait between reads, even for a retry that is far off.
    var longestPoll: Duration
    /// Sends of one action when the connection drops before an answer.
    var sendAttempts: Int
    var sendRetryDelay: Duration

    static let standard = DetailTiming(
        poll: .seconds(1),
        longestPoll: .seconds(15),
        sendAttempts: 3,
        sendRetryDelay: .seconds(1),
    )
}

extension Duration {
    /// The duration in seconds, as a `Double`.
    var seconds: Double {
        let (seconds, attoseconds) = components
        return Double(seconds) + Double(attoseconds) / 1e18
    }
}
