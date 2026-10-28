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
    /// The screen ran its first load, so a request made on opening it (List everywhere) is done.
    var hasLoadedOnce = false

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

    /// Follows the item while a change is in progress, until none is. The server answers a wait
    /// the moment one of the item's operations changes (`waitForItemChange`), and the item is
    /// read again then, so a change waiting for the phone or a retry costs one request every
    /// ``DetailTiming/changeWait`` instead of one a second. When the wait fails (Listora can't be
    /// reached), the item is read on a timer instead: every ``DetailTiming/poll``, or when a
    /// retry is due (at most ``DetailTiming/longestPoll``).
    func followChanges() async {
        var token: String?
        while !Task.isCancelled {
            guard isWorking else {
                token = nil
                try? await Task.sleep(for: timing.poll)
                continue
            }
            do {
                let answer = try await service.waitForChange(
                    itemID: itemID,
                    after: token,
                    waitSeconds: Int(timing.changeWait.components.seconds),
                )
                guard !Task.isCancelled else { return }
                token = answer.token
                if answer.changed {
                    await refresh()
                }
            } catch {
                guard !Task.isCancelled else { return }
                token = nil
                try? await Task.sleep(for: pollDelay())
                guard !Task.isCancelled else { return }
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

    /// The same change on several marketplaces at once (Relist all, End all): each is queued on
    /// its own, at the same time, and each listing's status then says how its change goes. One
    /// that can't reach Listora says so by its marketplace's name; the others still go.
    func performAll(_ requests: [(request: ListingRequest, marketplace: String)]) async {
        guard busyMarketplace == nil, !requests.isEmpty else { return }
        busyMarketplace = Self.allMarketplaces
        notice = nil
        defer { busyMarketplace = nil }
        let service = service
        let attempts = timing.sendAttempts
        let delay = timing.sendRetryDelay
        let failures = await withTaskGroup(of: String?.self) { group in
            for (request, marketplace) in requests {
                group.addTask {
                    let key = UUID().uuidString
                    for attempt in 1 ... max(1, attempts) {
                        do {
                            _ = try await service.perform(request, idempotencyKey: key)
                            return nil
                        } catch let error as APIFailure {
                            if Self.mayResend(error), attempt < attempts {
                                try? await Task.sleep(for: delay)
                                continue
                            }
                            return "\(Formatting.marketplaceName(marketplace)): \(error.message)"
                        } catch {
                            return "\(Formatting.marketplaceName(marketplace)): \(error.localizedDescription)"
                        }
                    }
                    return nil
                }
            }
            var failed: [String] = []
            for await failure in group {
                if let failure {
                    failed.append(failure)
                }
            }
            return failed.sorted()
        }
        if !failures.isEmpty {
            notice = failures.joined(separator: "\n")
        }
        await refresh()
    }

    /// Whether a send that failed is sent again (with the same idempotency key, so it is applied
    /// once): Listora couldn't be reached, or its gateway answered for it while it restarted.
    nonisolated static func mayResend(_ error: APIFailure) -> Bool {
        error.retryable && (error.statusCode == nil || error.code == "server_unavailable")
    }

    /// `busyMarketplace` while a change goes to several marketplaces at once.
    static let allMarketplaces = "all"

    /// Try now: the operation waiting for its next attempt runs that attempt at once.
    func tryNow(operationID: String, marketplace: String) async {
        await run(marketplace: marketplace) { [service] key throws(APIFailure) in
            _ = try await service.tryNow(operationID: operationID, idempotencyKey: key)
        }
    }

    /// The item's "Don't sell below" price on `marketplace`, for the price change to warn below
    /// it; nil without a cost or when the server can't say.
    func floor(on marketplace: String) async -> Money? {
        let floors = try? await service.floors(itemID: itemID)
        return floors?.first { $0.marketplace.value1?.rawValue == marketplace || $0.marketplace.value2 == marketplace }?
            .floorPrice
    }

    /// Saves the item's size (empty removes it), the detail a marketplace most often refuses a
    /// clothing listing without. A change made elsewhere meanwhile (`409`) is read again and the
    /// size applied to it once. Returns the failure to show, or nil once saved.
    func saveSize(_ size: String) async -> String? {
        guard var current = item else { return "The item isn't loaded yet." }
        let label = size.trimmingCharacters(in: .whitespacesAndNewlines)
        for attempt in 1 ... 2 {
            var details = current.details
            details.sizeLabel = label.isEmpty ? nil : label
            do {
                let saved = try await service.replaceItem(
                    id: itemID,
                    with: .init(expectedVersion: current.version, details: details),
                )
                await apply(saved)
                return nil
            } catch {
                guard error.statusCode == 409, attempt == 1,
                      let latest = try? await service.item(id: itemID)
                else {
                    return error.message
                }
                current = latest
            }
        }
        return nil
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
                if Self.mayResend(error), attempt < timing.sendAttempts {
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

/// How the item screen follows the server while a change runs.
struct DetailTiming: Sendable {
    /// How often the screen looks whether a change runs, and reads the item while it can't wait.
    var poll: Duration
    /// The longest wait between reads, even for a retry that is far off.
    var longestPoll: Duration
    /// Sends of one action when the connection drops before an answer.
    var sendAttempts: Int
    var sendRetryDelay: Duration
    /// The longest one wait for a change holds (the server answers within 20 seconds).
    var changeWait: Duration = .seconds(20)

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
