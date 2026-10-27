import APIClient
import Core
import Foundation
import ListoraAPI
import Observation

/// Runs a ``BulkAction`` over items: each item is read fresh from the server (its listings and
/// the actions they allow now), then each change goes through the same calls as the item screen,
/// each with its own Idempotency-Key, sent again with that key when the answer was lost. A few
/// items run at once; every item, and every marketplace of it, gets its own outcome.
@MainActor
@Observable
final class BulkActionModel: Identifiable {
    enum Phase: Equatable {
        case choosing
        case running
        case finished
    }

    /// One marketplace to list on, as the sheet offers it.
    struct Destination: Identifiable, Equatable, Sendable {
        let id: String
        let name: String
        /// How Listora lists there, or why it can't yet.
        let detail: String
        let isAvailable: Bool
        let isAssisted: Bool
    }

    /// The items the change is for, in the order they were chosen.
    let items: [ItemSummary]
    private(set) var phase = Phase.choosing
    private(set) var destinations: [Destination] = []
    /// The marketplaces chosen for List.
    var chosen: Set<String> = []
    private(set) var outcomes: [BulkOutcome] = []
    /// The last action run, for Try again.
    private(set) var lastAction: BulkAction?
    private(set) var finishedItems = 0

    let service: any InventoryService
    let listingCopy: ListingCopyStore
    let timing: DetailTiming
    private(set) var connections: [Connection] = []
    /// How many items run at once.
    static let parallelItems = 4

    nonisolated var id: ObjectIdentifier {
        ObjectIdentifier(self)
    }

    init(
        items: [ItemSummary],
        service: any InventoryService,
        listingCopy: ListingCopyStore,
        timing: DetailTiming = .standard,
    ) {
        self.items = items
        self.service = service
        self.listingCopy = listingCopy
        self.timing = timing
    }

    /// Loads the connections and works out where the items can be listed: every marketplace
    /// Listora lists on itself is chosen at first; assisted ones are offered, not chosen.
    func prepare() async {
        connections = await (try? service.connections()) ?? []
        destinations = KnownMarketplace.allCases.map { marketplace in
            let id = marketplace.rawValue
            let name = Formatting.marketplaceName(id)
            let connection = connections.first { $0.marketplace.value1 == marketplace }
            let assisted = MarketplaceRowState.isAssisted(marketplace: marketplace, connection: connection)
            guard MarketplaceRowState.canList(marketplace: marketplace, connection: connection) else {
                return Destination(
                    id: id,
                    name: name,
                    detail: "Connect \(name) in Settings > Marketplaces first",
                    isAvailable: false,
                    isAssisted: assisted,
                )
            }
            return Destination(
                id: id,
                name: name,
                detail: assisted
                    ? "You post it in the \(name) app: Listora adds a task with everything to copy."
                    : "Listora posts it for you on \(name).",
                isAvailable: true,
                isAssisted: assisted,
            )
        }
        chosen = Set(destinations.filter { $0.isAvailable && !$0.isAssisted }.map(\.id))
    }

    var total: Int {
        items.count
    }

    var failedOutcomes: [BulkOutcome] {
        outcomes.filter { $0.result == .failed }
    }

    /// "Started on 5, done 1, skipped 2, failed 1": what happened, by kind.
    var summary: String {
        let counts: [(BulkOutcome.Result, String)] = [
            (.started, "started"), (.done, "done"), (.skipped, "skipped"), (.failed, "failed"),
        ]
        return counts.compactMap { result, word in
            let count = outcomes.count(where: { $0.result == result })
            return count == 0 ? nil : "\(count) \(word)"
        }.joined(separator: ", ")
    }

    /// Runs `action` over every item.
    func run(_ action: BulkAction) async {
        await run(action, on: items)
    }

    /// Runs the last action again for the items where it failed (a skipped one needs the seller).
    func retryFailed() async {
        guard let lastAction else { return }
        let failed = Set(failedOutcomes.map(\.itemID))
        outcomes.removeAll { failed.contains($0.itemID) }
        await run(lastAction, on: items.filter { failed.contains($0.id) }, keepOutcomes: true)
    }

    private func run(_ action: BulkAction, on targets: [ItemSummary], keepOutcomes: Bool = false) async {
        guard phase != .running, !targets.isEmpty else { return }
        lastAction = action
        phase = .running
        if !keepOutcomes {
            outcomes = []
        }
        finishedItems = keepOutcomes ? total - targets.count : 0
        var queue = targets[...]
        await withTaskGroup(of: [BulkOutcome].self) { group in
            for _ in 0 ..< Self.parallelItems {
                guard let next = queue.popFirst() else { break }
                group.addTask { await self.changes(of: action, for: next) }
            }
            for await result in group {
                outcomes += result
                finishedItems += 1
                if let next = queue.popFirst() {
                    group.addTask { await self.changes(of: action, for: next) }
                }
            }
        }
        // In the order the items were chosen, each item's marketplaces in the app's order, then
        // the item's own change.
        let order = Dictionary(uniqueKeysWithValues: items.enumerated().map { ($1.id, $0) })
        let marketplaces = KnownMarketplace.allCases.map(\.rawValue)
        let place = { (outcome: BulkOutcome) in
            (order[outcome.itemID] ?? 0, outcome.marketplace.flatMap { marketplaces.firstIndex(of: $0) } ?? Int.max)
        }
        outcomes.sort { place($0) < place($1) }
        phase = .finished
    }

    private func changes(of action: BulkAction, for summary: ItemSummary) async -> [BulkOutcome] {
        let item: Item
        do {
            item = try await send { [service] _ throws(APIFailure) in try await service.item(id: summary.id) }
        } catch {
            return [outcome(summary, nil, .failed, error.message)]
        }
        switch action {
        case let .list(marketplaces):
            var results: [BulkOutcome] = []
            for marketplace in KnownMarketplace.allCases where marketplaces.contains(marketplace.rawValue) {
                await results.append(list(item, on: marketplace))
            }
            return results
        case let .end(reason):
            return await perform(on: item, allowing: .end, nothing: "Not live anywhere, so nothing to end.") {
                .end(listingID: $0.id, reason: reason.contract)
            }
        case .relist:
            return await perform(on: item, allowing: .relist, nothing: "No ended listing to relist.") {
                .relist(listingID: $0.id)
            }
        case let .changePrice(adjustment):
            return await changePrice(of: item, by: adjustment)
        case .delete:
            return await [delete(item)]
        }
    }
}
