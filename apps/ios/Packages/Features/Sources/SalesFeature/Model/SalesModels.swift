import APIClient
import Core
import Foundation
import ListoraAPI
import Observation

/// How the sales screens send and follow changes.
struct SalesTiming: Sendable {
    /// How often a sale is read while its delists run.
    var poll: Duration
    /// Sends of one request when the connection drops before an answer.
    var sendAttempts: Int
    var sendRetryDelay: Duration

    static let standard = SalesTiming(poll: .seconds(1), sendAttempts: 3, sendRetryDelay: .seconds(1))
}

/// Sends one request with its own Idempotency-Key, again with the same key when the answer was
/// lost, so a retry never records a sale or a change twice. Returns the answer, or the failure
/// to show.
@MainActor
func sendOnce<Value: Sendable>(
    timing: SalesTiming,
    key: String = UUID().uuidString,
    _ send: @Sendable (String) async throws(APIFailure) -> Value,
) async -> Result<Value, APIFailure> {
    var attempt = 0
    while true {
        do {
            return try await .success(send(key))
        } catch {
            attempt += 1
            if error.statusCode == nil, error.retryable, attempt < timing.sendAttempts {
                try? await Task.sleep(for: timing.sendRetryDelay)
                continue
            }
            return .failure(error)
        }
    }
}

/// The Sales tab: recent sales, newest first, each with its profit.
@MainActor
@Observable
final class SalesListModel {
    enum Phase: Equatable {
        case loading
        case loaded
        case signedOut
        case failed(message: String)
    }

    private(set) var sales: [Sale] = []
    private(set) var phase: Phase = .loading
    private(set) var hasMore = false
    /// The newest sale, when it arrived since the list last loaded while the app was open: the
    /// Sales tab celebrates it. The first load sets nothing.
    private(set) var newSaleID: String?
    private var cursor: String?
    private let service: any SalesService
    private let isSignedIn: @MainActor () -> Bool

    init(service: any SalesService, isSignedIn: @escaping @MainActor () -> Bool = { true }) {
        self.service = service
        self.isSignedIn = isSignedIn
    }

    func load() async {
        guard isSignedIn() else {
            sales = []
            phase = .signedOut
            return
        }
        if sales.isEmpty {
            phase = .loading
        }
        do {
            let page = try await service.sales(cursor: nil)
            if phase == .loaded, let newest = page.sales.first, !sales.contains(where: { $0.id == newest.id }) {
                newSaleID = newest.id
            }
            sales = page.sales
            cursor = page.nextCursor
            hasMore = page.nextCursor != nil
            phase = .loaded
        } catch {
            phase = .failed(message: error.message)
        }
    }

    func loadMore() async {
        guard let cursor, let page = try? await service.sales(cursor: cursor) else { return }
        let known = Set(sales.map(\.id))
        sales += page.sales.filter { !known.contains($0.id) }
        self.cursor = page.nextCursor
        hasMore = page.nextCursor != nil
    }
}

/// "Mark as sold": the marketplace it sold on, the sale price of each item (more than one for a
/// bundle), the shipping the buyer paid, and the day. Recording it starts the same automatic
/// delist as a sale Listora detected.
@MainActor
@Observable
final class MarkSoldModel: Identifiable {
    struct Line: Identifiable, Equatable {
        let itemID: String
        let sku: String
        let title: String?
        var priceCents: Int?

        var id: String {
            itemID
        }
    }

    let request: MarkSoldRequest
    var marketplace: KnownMarketplace?
    var lines: [Line]
    var shippingCents: Int? = 0
    var soldAt: Date
    var orderNumber = ""
    private(set) var isSaving = false
    /// Why the sale wasn't recorded, safe to show.
    var failure: String?
    /// Items to add to the order, from the search.
    private(set) var candidates: [ItemSummary] = []

    private let service: any SalesService
    private let timing: SalesTiming
    /// Kept across retries, so a sale whose answer was lost is never recorded twice.
    private var key = UUID().uuidString

    nonisolated var id: String {
        request.itemID
    }

    init(request: MarkSoldRequest, service: any SalesService, timing: SalesTiming = .standard, now: Date = Date()) {
        self.request = request
        self.service = service
        self.timing = timing
        soldAt = now
        lines = [Line(
            itemID: request.itemID,
            sku: request.sku,
            title: request.title,
            priceCents: request.listPriceCents.map { Int($0) },
        )]
        // The one marketplace it is listed on is the likely one; with several, the seller picks.
        let listed = request.listedOn.compactMap(KnownMarketplace.init(rawValue:))
        marketplace = listed.count == 1 ? listed.first : nil
    }

    /// The marketplaces in the picker: where the item is listed first, then the rest.
    var marketplaces: [KnownMarketplace] {
        let listed = request.listedOn.compactMap(KnownMarketplace.init(rawValue:))
        return listed + KnownMarketplace.allCases.filter { !listed.contains($0) }
    }

    /// What still keeps the sale from being recorded, in the form's words; nil when it can be.
    var missing: String? {
        if marketplace == nil {
            return "Choose where it sold."
        }
        if lines.contains(where: { $0.priceCents == nil }) {
            return "Enter what each item sold for."
        }
        if shippingCents == nil {
            return "Enter the shipping the buyer paid, or $0."
        }
        return nil
    }

    var totalCents: Int {
        lines.compactMap(\.priceCents).reduce(0, +)
    }

    func search(_ text: String) async {
        guard let items = try? await service.sellableItems(search: text) else { return }
        candidates = items.filter { item in !lines.contains { $0.itemID == item.id } }
    }

    func add(_ item: ItemSummary) {
        guard !lines.contains(where: { $0.itemID == item.id }) else { return }
        lines.append(Line(
            itemID: item.id,
            sku: item.sku,
            title: item.title,
            priceCents: item.listPrice.map { Int($0.amountCents) },
        ))
        candidates.removeAll { $0.id == item.id }
        changed()
    }

    func remove(itemID: String) {
        guard itemID != request.itemID else { return }
        lines.removeAll { $0.itemID == itemID }
        changed()
    }

    /// A changed form is a different request: it gets a new key.
    func changed() {
        key = UUID().uuidString
        failure = nil
    }

    /// Records the sale; returns it once the server has.
    func save() async -> Sale? {
        guard missing == nil, let marketplace, let shippingCents, !isSaving else { return nil }
        isSaving = true
        failure = nil
        defer { isSaving = false }
        let order = orderNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        let sale = NewSale(
            marketplace: marketplace,
            lines: lines.map { NewSale.Line(itemID: $0.itemID, priceCents: Int64($0.priceCents ?? 0)) },
            shippingChargedCents: Int64(shippingCents),
            soldAt: min(soldAt, Date()),
            orderNumber: order.isEmpty ? nil : order,
        )
        switch await sendOnce(timing: timing, key: key, { [service] key throws(APIFailure) in
            try await service.record(sale, idempotencyKey: key)
        }) {
        case let .success(recorded):
            return recorded
        case let .failure(error):
            failure = error.message
            return nil
        }
    }
}

/// One sale: its items, fees, payout, profit, and ROI; the delist on every other marketplace,
/// as the server reports it; the steps its status allows; and, after a cancel or return, the
/// question whether to relist, which only the seller answers.
@MainActor
@Observable
final class SaleDetailModel {
    enum Phase: Equatable {
        case loading
        case loaded
        case failed(message: String)
    }

    let saleID: String
    private(set) var sale: Sale?
    /// How Listora found the sale and what its delists did; absent until read (or if it can't be).
    private(set) var explanation: SaleExplanation?
    private(set) var phase: Phase = .loading
    private(set) var isSending = false
    /// The last change's failure to reach the server, safe to show.
    var notice: String?
    /// The relist question being answered: per item, the listings chosen.
    var relistChoices: [String: Set<String>] = [:]

    private let service: any SalesService
    private let timing: SalesTiming

    init(saleID: String, service: any SalesService, timing: SalesTiming = .standard) {
        self.saleID = saleID
        self.service = service
        self.timing = timing
    }

    /// True while a delist of the sale is still running, so the screen keeps reading the server.
    var isWorking: Bool {
        sale?.delistRuns.contains { $0.status == .inProgress } ?? false
    }

    func load() async {
        if sale == nil {
            phase = .loading
        }
        do {
            sale = try await service.sale(id: saleID)
            phase = .loaded
            // Best effort: the sale screen works without it.
            if let explained = try? await service.explanation(saleID: saleID) {
                explanation = explained
            }
        } catch {
            if sale == nil {
                phase = .failed(message: error.message)
            }
        }
    }

    /// Reads the sale again while its delists run.
    func followChanges() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: timing.poll)
            guard !Task.isCancelled else { return }
            if isWorking, let latest = try? await service.sale(id: saleID) {
                sale = latest
            }
        }
    }

    func perform(_ change: SaleChange) async {
        await send { [service, saleID] key throws(APIFailure) in
            try await service.change(saleID: saleID, change, idempotencyKey: key)
        }
    }

    /// Relists the chosen listings of each item whose question is open; none chosen: don't relist.
    func answerRelist() async {
        guard let sale else { return }
        let choices = Dictionary(uniqueKeysWithValues: sale.pendingRelists.map { item in
            (item.itemId, (relistChoices[item.itemId] ?? []).sorted())
        })
        guard !choices.isEmpty else { return }
        await send { [service, saleID] key throws(APIFailure) in
            try await service.decideRelist(saleID: saleID, choices: choices, idempotencyKey: key)
        }
        relistChoices = [:]
    }

    /// Declines to relist every item whose question is open.
    func declineRelist() async {
        relistChoices = [:]
        await answerRelist()
    }

    func toggle(listingID: String, of itemID: String) {
        var chosen = relistChoices[itemID] ?? []
        if chosen.contains(listingID) {
            chosen.remove(listingID)
        } else {
            chosen.insert(listingID)
        }
        relistChoices[itemID] = chosen
    }

    private func send(_ request: @escaping @Sendable (String) async throws(APIFailure) -> Sale) async {
        guard !isSending else { return }
        isSending = true
        notice = nil
        defer { isSending = false }
        switch await sendOnce(timing: timing, request) {
        case let .success(updated):
            sale = updated
        case let .failure(error):
            notice = error.message
            await load()
        }
    }
}
