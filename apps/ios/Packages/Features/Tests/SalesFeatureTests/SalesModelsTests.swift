import APIClient
import Core
import Foundation
import ListoraAPI
import Testing
@testable import SalesFeature

private typealias Schemas = Components.Schemas

/// A scripted ``SalesService`` that records what it was asked.
private final class FakeSalesService: SalesService, @unchecked Sendable {
    private let lock = NSLock()
    private var _sale: Schemas.Sale
    private var _pages: [SalePage] = []
    private var _failures: [APIFailure] = []
    private var _recorded: [(NewSale, String)] = []
    private var _changes: [(SaleChange, String)] = []
    private var _relists: [[String: [String]]] = []

    init(sale: Schemas.Sale) {
        _sale = sale
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    var sale: Schemas.Sale {
        get { locked { _sale } }
        set { locked { _sale = newValue } }
    }

    var pages: [SalePage] {
        get { locked { _pages } }
        set { locked { _pages = newValue } }
    }

    /// Thrown by the next calls that can fail, one each.
    var failures: [APIFailure] {
        get { locked { _failures } }
        set { locked { _failures = newValue } }
    }

    var recorded: [(NewSale, String)] {
        locked { _recorded }
    }

    var changes: [(SaleChange, String)] {
        locked { _changes }
    }

    var relists: [[String: [String]]] {
        locked { _relists }
    }

    private func fail() throws(APIFailure) {
        if let failure = locked({ _failures.isEmpty ? nil : _failures.removeFirst() }) {
            throw failure
        }
    }

    func sales(cursor _: String?) async throws(APIFailure) -> SalePage {
        try fail()
        return locked { _pages.isEmpty ? SalePage(sales: [], nextCursor: nil) : _pages.removeFirst() }
    }

    func sale(id _: String) async throws(APIFailure) -> Schemas.Sale {
        try fail()
        return sale
    }

    func sellableItems(search _: String) async throws(APIFailure) -> [Schemas.ItemSummary] {
        [summary(id: "item-2", sku: "AJ-000002"), summary(id: "item-1", sku: "AJ-000001")]
    }

    func record(_ sale: NewSale, idempotencyKey: String) async throws(APIFailure) -> Schemas.Sale {
        locked { _recorded.append((sale, idempotencyKey)) }
        try fail()
        return self.sale
    }

    func change(saleID _: String, _ change: SaleChange, idempotencyKey: String) async throws(APIFailure)
        -> Schemas.Sale
    {
        locked { _changes.append((change, idempotencyKey)) }
        try fail()
        return sale
    }

    func decideRelist(
        saleID _: String,
        choices: [String: [String]],
        idempotencyKey _: String,
    ) async throws(APIFailure) -> Schemas.Sale {
        locked { _relists.append(choices) }
        try fail()
        return sale
    }
}

private let now = Date(timeIntervalSince1970: 1_792_900_000)

private func usd(_ cents: Int64) -> Schemas.Money {
    .init(amountCents: cents, currency: .usd)
}

private func summary(id: String, sku: String) -> Schemas.ItemSummary {
    .init(
        id: id,
        sku: sku,
        status: .init(value1: .ready),
        title: "Coach bag",
        listPrice: usd(6000),
        listings: [],
        createdAt: now,
        updatedAt: now,
    )
}

private func sale(
    status: Schemas.KnownSaleStatus = .detected,
    actions: [Schemas.KnownSaleAction] = [.confirm, .markShipped, .cancel],
    relist: Schemas.SaleRelist? = nil,
    runStatus: Schemas.DelistRunStatus? = nil,
) -> Schemas.Sale {
    .init(
        id: "sale-1",
        marketplace: .init(value1: .depop),
        items: [.init(
            itemId: "item-1",
            sku: "AJ-000001",
            title: "Levi's Trucker Denim Jacket",
            salePrice: usd(4000),
            profit: usd(2000),
            relist: relist,
        )],
        soldAt: now,
        salePrice: usd(4000),
        fees: [.init(_type: .init(value1: .payment), amount: usd(177), source: .estimated)],
        feesEstimated: true,
        netProceeds: usd(3823),
        profit: usd(2000),
        roiBasisPoints: 16667,
        detectionSource: .init(value1: .manual),
        status: .init(value1: status),
        availableActions: actions.map { .init(value1: $0) },
        isDoubleSale: false,
        delistRuns: runStatus.map { status in
            [.init(
                id: "run-1",
                saleId: "sale-1",
                itemId: "item-1",
                soldOn: .init(value1: .depop),
                status: status,
                statusDisplay: .init(tone: .init(value1: .inProgress), label: "Delisting on eBay..."),
                results: [],
                escalated: false,
                startedAt: now,
            )]
        } ?? [],
        doubleSales: [],
        createdAt: now,
        updatedAt: now,
    )
}

private func option(_ listingID: String, _ marketplace: Schemas.KnownMarketplace, canRelist: Bool)
    -> Schemas.RelistOption
{
    .init(
        listingId: listingID,
        marketplace: .init(value1: marketplace),
        mode: .init(value1: canRelist ? .api : .assisted),
        statusDisplay: .init(tone: .init(value1: .success), label: "Delisted (confirmed by eBay)"),
        canRelist: canRelist,
    )
}

private let request = MarkSoldRequest(
    itemID: "item-1",
    sku: "AJ-000001",
    title: "Levi's Trucker Denim Jacket",
    listPriceCents: 4500,
    listedOn: ["ebay"],
)

private let fast = SalesTiming(poll: .milliseconds(5), sendAttempts: 3, sendRetryDelay: .milliseconds(1))

@MainActor
@Suite("Sales models")
struct SalesModelsTests {
    @Test
    func `mark sold starts from the item and offers where it is listed first`() {
        let model = MarkSoldModel(request: request, service: FakeSalesService(sale: sale()), timing: fast, now: now)
        #expect(model.marketplace == .ebay)
        #expect(model.marketplaces.first == .ebay)
        #expect(model.marketplaces.count == 4)
        #expect(model.lines.map(\.priceCents) == [4500])
        #expect(model.missing == nil)

        model.lines[0].priceCents = nil
        #expect(model.missing == "Enter what each item sold for.")
        model.lines[0].priceCents = 4000
        model.shippingCents = nil
        #expect(model.missing == "Enter the shipping the buyer paid, or $0.")
    }

    @Test
    func `an item listed in several places asks where it sold`() {
        let several = MarkSoldRequest(
            itemID: "item-1", sku: "AJ-000001", title: nil, listPriceCents: nil, listedOn: ["ebay", "poshmark"],
        )
        let model = MarkSoldModel(request: several, service: FakeSalesService(sale: sale()), timing: fast, now: now)
        #expect(model.marketplace == nil)
        #expect(model.missing == "Choose where it sold.")
        #expect(model.marketplaces.prefix(2) == [.ebay, .poshmark])
    }

    @Test
    func `records a bundle once, sending again with the same key when the answer was lost`() async {
        let service = FakeSalesService(sale: sale())
        service.failures = [.networkUnavailable]
        let model = MarkSoldModel(request: request, service: service, timing: fast, now: now)
        model.marketplace = .depop
        model.lines[0].priceCents = 4000
        await model.search("coach")
        #expect(model.candidates.map(\.id) == ["item-2"])
        model.add(model.candidates[0])
        model.orderNumber = "  P-123  "

        let recorded = await model.save()
        #expect(recorded?.id == "sale-1")
        #expect(service.recorded.count == 2)
        #expect(service.recorded[0].1 == service.recorded[1].1)
        let sent = service.recorded[1].0
        #expect(sent.marketplace == .depop)
        #expect(sent.lines == [.init(itemID: "item-1", priceCents: 4000), .init(itemID: "item-2", priceCents: 6000)])
        #expect(sent.orderNumber == "P-123")
        #expect(sent.shippingChargedCents == 0)
    }

    @Test
    func `shows a refused sale, and a changed form is sent as a new request`() async {
        let service = FakeSalesService(sale: sale())
        service.failures = [APIFailure(
            statusCode: 409,
            code: "already_exists",
            message: "This order is already recorded in Listora.",
            retryable: false,
        )]
        let model = MarkSoldModel(request: request, service: service, timing: fast, now: now)
        #expect(await model.save() == nil)
        #expect(model.failure == "This order is already recorded in Listora.")
        model.orderNumber = "P-124"
        model.changed()
        #expect(model.failure == nil)
        #expect(await model.save() != nil)
        #expect(service.recorded[0].1 != service.recorded[1].1)
        // The item the sale started from stays in it.
        model.remove(itemID: "item-1")
        #expect(model.lines.map(\.itemID) == ["item-1"])
    }

    @Test
    func `a sale's steps go to the server, which decides the new status`() async {
        let service = FakeSalesService(sale: sale(status: .confirmed, actions: [.markShipped, .cancel, .recordReturn]))
        let model = SaleDetailModel(saleID: "sale-1", service: service, timing: fast)
        await model.load()
        #expect(model.sale?.knownActions == [.markShipped, .cancel, .recordReturn])
        service.sale = sale(status: .shipped, actions: [.recordReturn])
        await model.perform(.markShipped(labelCostCents: 650))
        #expect(service.changes.map(\.0) == [.markShipped(labelCostCents: 650)])
        #expect(model.sale?.status.value1 == .shipped)
        #expect(model.notice == nil)

        service.failures = [APIFailure(
            statusCode: 409,
            code: "invalid_state_transition",
            message: "Only a new sale can be confirmed.",
            retryable: false,
        )]
        await model.perform(.confirm)
        #expect(model.notice == "Only a new sale can be confirmed.")
    }

    @Test
    func `after a cancel, relists only the listings the seller chose, or none`() async {
        let pending = Schemas.SaleRelist(
            decision: .init(value1: .pending),
            options: [
                option("listing-ebay", .ebay, canRelist: true),
                option("listing-posh", .poshmark, canRelist: false),
            ],
        )
        let service = FakeSalesService(sale: sale(status: .canceled, actions: [], relist: pending))
        let model = SaleDetailModel(saleID: "sale-1", service: service, timing: fast)
        await model.load()
        #expect(model.sale?.pendingRelists.map(\.itemId) == ["item-1"])
        #expect(service.relists.isEmpty)

        model.toggle(listingID: "listing-ebay", of: "item-1")
        model.toggle(listingID: "listing-ebay", of: "item-1")
        model.toggle(listingID: "listing-ebay", of: "item-1")
        await model.answerRelist()
        #expect(service.relists == [["item-1": ["listing-ebay"]]])

        await model.declineRelist()
        #expect(service.relists.last == ["item-1": []])
    }

    @Test
    func `keeps reading a sale while its delists run`() async {
        let service = FakeSalesService(sale: sale(runStatus: .inProgress))
        let model = SaleDetailModel(saleID: "sale-1", service: service, timing: fast)
        await model.load()
        #expect(model.isWorking)
        service.sale = sale(runStatus: .completed)
        let following = Task { await model.followChanges() }
        for _ in 0 ..< 100 where model.isWorking {
            try? await Task.sleep(for: .milliseconds(5))
        }
        following.cancel()
        #expect(!model.isWorking)
    }

    @Test
    func `the sales list pages on, and stays quiet signed out`() async {
        let service = FakeSalesService(sale: sale())
        service.pages = [
            SalePage(sales: [sale()], nextCursor: "c1"),
            SalePage(sales: [sale(status: .shipped)], nextCursor: nil),
        ]
        let list = SalesListModel(service: service)
        await list.load()
        #expect(list.phase == .loaded)
        #expect(list.hasMore)
        await list.loadMore()
        // The same sale on the next page (it moved) is not shown twice.
        #expect(list.sales.count == 1)
        #expect(!list.hasMore)

        let signedOut = SalesListModel(service: service) { false }
        await signedOut.load()
        #expect(signedOut.phase == .signedOut)
    }

    @Test
    func `a sale that arrives while the app is open is the one to celebrate, not the ones already there`() async {
        var newer = sale()
        newer.id = "sale-2"
        let service = FakeSalesService(sale: sale())
        service.pages = [
            SalePage(sales: [sale()], nextCursor: nil),
            SalePage(sales: [sale()], nextCursor: nil),
            SalePage(sales: [newer, sale()], nextCursor: nil),
        ]
        let list = SalesListModel(service: service)
        await list.load()
        #expect(list.newSaleID == nil, "the first load celebrates nothing")
        await list.load()
        #expect(list.newSaleID == nil, "nothing new")
        await list.load()
        #expect(list.newSaleID == "sale-2")
    }

    @Test
    func `formats ROI with its sign`() {
        #expect(SaleFormatting.roi(basisPoints: 16667) == "+166.7%")
        #expect(SaleFormatting.roi(basisPoints: -9333) == "-93.3%")
        #expect(SaleFormatting.roi(basisPoints: 0) == "0%")
    }
}
