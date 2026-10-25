import Core
import Foundation
import Observation

/// The rapid review of a batch (docs/features/batch.md): one page per item, swiped through in haul
/// order. Each page is the single-item review's model (``ReviewFlowModel``), so an item goes
/// through the same analysis, details, cost, and price rules, and one tap approves it and moves
/// on. A cost and source entered once can apply to every item still to approve: the same amount
/// each, or a haul's total split across them.
@MainActor
@Observable
final class BatchReviewModel {
    /// How a haul's cost applies to the items still to approve.
    enum CostSplit: Equatable {
        /// Every item cost this much.
        case each(Int64)
        /// The haul cost this much in all, split evenly.
        case total(Int64)
    }

    struct Summary: Equatable {
        let saved: [ReviewFlowModel.SavedItem]
        /// The whole batch: its capture and grouping, plus every saved item's review.
        let active: TimeInterval
        let taps: Int

        var averageActive: TimeInterval {
            saved.isEmpty ? 0 : active / Double(saved.count)
        }

        /// The average item met Listora's goal of less than about 30 seconds of the seller's time.
        var meetsGoal: Bool {
            averageActive <= InteractionSummary.goal
        }
    }

    let request: BatchReviewRequest
    let pages: [ReviewFlowModel]
    let meter: InteractionMeter
    let recentSources: RecentPurchaseSources
    private let onEvent: @MainActor (BatchReviewEvent) -> Void
    /// The page showing.
    var index = 0 {
        didSet { measure() }
    }

    /// Shown after the last item instead of a page.
    var showsSummary = false {
        didSet { measure() }
    }

    private var started: Set<Int> = []
    /// The amount the last Apply to all gave each item, by item.
    private var appliedCents: [ObjectIdentifier: Int64] = [:]
    /// The screen is in front of the seller.
    private var isVisible = false
    /// The item session the meter is counting now: the page showing.
    private var measuredSession: String?

    init(
        request: BatchReviewRequest,
        environment: ReviewEnvironment,
        onEvent: @escaping @MainActor (BatchReviewEvent) -> Void,
    ) {
        self.request = request
        self.onEvent = onEvent
        meter = environment.meter
        recentSources = environment.recentSources
        pages = request.items.map { item in
            environment.makeModel(for: ItemReviewRequest(sessionID: item.sessionID, itemID: item.itemID, sku: item.sku))
        }
    }

    var current: ReviewFlowModel? {
        pages.indices.contains(index) ? pages[index] : nil
    }

    var savedCount: Int {
        pages.count { $0.saved != nil && $0.phase != .alreadySaved }
    }

    /// Items not approved yet.
    var remaining: [ReviewFlowModel] {
        pages.filter { $0.saved == nil }
    }

    /// Loads the page showing and the one after it, so the next item is ready when the seller
    /// gets there. Loading a page twice does nothing.
    func pageAppeared(_ page: Int) async {
        await withTaskGroup(of: Void.self) { group in
            for target in [page, page + 1] where pages.indices.contains(target) && !started.contains(target) {
                started.insert(target)
                let model = pages[target]
                group.addTask { await model.start() }
            }
        }
    }

    /// Approves the page's item, then shows the next item not yet approved (or the summary).
    func approve(_ page: ReviewFlowModel) async {
        guard await page.approve(), let saved = page.saved else { return }
        onEvent(.saved(
            sessionID: page.request.sessionID,
            itemID: page.request.itemID,
            sku: saved.sku,
            summary: saved.summary,
        ))
        advance()
    }

    /// Leaves the item for later and shows the next one.
    func skip() {
        advance()
    }

    private func advance() {
        let order = Array(pages.indices.dropFirst(index + 1)) + Array(pages.indices.prefix(index + 1))
        if let next = order.first(where: { pages[$0].saved == nil }) {
            index = next
        } else {
            showsSummary = true
        }
    }

    /// Applies the page's cost, date, and source to every other item not approved yet.
    func applyCost(from page: ReviewFlowModel, as split: CostSplit) {
        let targets = remaining
        let amounts = Self.amounts(split, count: targets.count)
        for (target, cents) in zip(targets, amounts) {
            target.cost.amount = AmountEntry(cents: cents)
            target.cost.purchaseDate = page.cost.purchaseDate
            target.cost.source = page.cost.source
            appliedCents[ObjectIdentifier(target)] = cents
        }
    }

    /// The page shows the cost Apply to all gave it: applying again would apply that share.
    func hasAppliedCost(_ page: ReviewFlowModel) -> Bool {
        appliedCents[ObjectIdentifier(page)].map { $0 == page.cost.amount.cents } ?? false
    }

    /// Each item's share: the same for all, or the total split with the leftover cents on the first
    /// items, so the shares always add up to the total.
    static func amounts(_ split: CostSplit, count: Int) -> [Int64] {
        guard count > 0 else { return [] }
        switch split {
        case let .each(cents):
            return Array(repeating: cents, count: count)
        case let .total(cents):
            let share = cents / Int64(count)
            let leftover = Int(cents % Int64(count))
            return (0 ..< count).map { share + ($0 < leftover ? 1 : 0) }
        }
    }

    /// The seller is done: tells Add Item, which keeps the batch's measured interaction.
    func finish() {
        onEvent(.finished)
    }

    func setVisible(_ visible: Bool) {
        isVisible = visible
        measure()
    }

    /// Counts the seller's time and taps toward the item whose page shows, and only that one (a
    /// page view keeps its neighbors loaded, so their own appearing says nothing).
    private func measure() {
        let wanted = isVisible && !showsSummary ? current?.request.sessionID : nil
        guard wanted != measuredSession else { return }
        if let measuredSession {
            meter.leave(measuredSession)
        }
        if let wanted {
            meter.enter(wanted)
        }
        measuredSession = wanted
    }

    /// What the review did, for its summary: the saved items and the whole batch's time and taps.
    var summary: Summary {
        let saved = pages.compactMap { $0.phase == .alreadySaved ? nil : $0.saved }
        let shared = meter.session(request.batchSessionID)
        let items = saved.compactMap(\.summary)
        return Summary(
            saved: saved,
            active: (shared?.active ?? 0) + items.reduce(0) { $0 + $1.active },
            taps: (shared?.taps ?? 0) + items.reduce(0) { $0 + $1.taps },
        )
    }
}
