import APIClient
import Foundation
import ListoraAPI
import Testing
@testable import SalesFeature

private typealias Schemas = Components.Schemas

/// A ``SalesService`` whose list answers its pages in turn and records the order each read asked
/// for; nothing else is asked of it.
private final class SortedSalesService: SalesService, @unchecked Sendable {
    private let lock = NSLock()
    private var pages: [SalePage]
    private var _sorts: [SaleSort] = []

    init(pages: [SalePage]) {
        self.pages = pages
    }

    var sorts: [SaleSort] {
        lock.withLock { _sorts }
    }

    func sales(sort: SaleSort, cursor _: String?) async throws(APIFailure) -> SalePage {
        lock.withLock {
            _sorts.append(sort)
            return pages.isEmpty ? SalePage(sales: [], nextCursor: nil) : pages.removeFirst()
        }
    }

    func sale(id _: String) async throws(APIFailure) -> Schemas.Sale {
        throw .networkUnavailable
    }

    func explanation(saleID _: String) async throws(APIFailure) -> Schemas.SaleExplanation {
        throw .networkUnavailable
    }

    func sellableItems(search _: String) async throws(APIFailure) -> [Schemas.ItemSummary] {
        []
    }

    func record(_: NewSale, idempotencyKey _: String) async throws(APIFailure) -> Schemas.Sale {
        throw .networkUnavailable
    }

    func change(saleID _: String, _: SaleChange, idempotencyKey _: String) async throws(APIFailure)
        -> Schemas.Sale
    {
        throw .networkUnavailable
    }

    func decideRelist(saleID _: String, choices _: [String: [String]], idempotencyKey _: String)
        async throws(APIFailure) -> Schemas.Sale
    {
        throw .networkUnavailable
    }
}

private func sale(id: String) -> Schemas.Sale {
    let now = Date(timeIntervalSince1970: 1_792_900_000)
    let money = Schemas.Money(amountCents: 4000, currency: .usd)
    return .init(
        id: id,
        marketplace: .init(value1: .depop),
        items: [.init(itemId: "item-\(id)", sku: "AJ-000001", salePrice: money)],
        soldAt: now,
        salePrice: money,
        detectionSource: .init(value1: .manual),
        status: .init(value1: .detected),
        availableActions: [],
        isDoubleSale: false,
        delistRuns: [],
        doubleSales: [],
        createdAt: now,
        updatedAt: now,
    )
}

/// The sales list's order: sent to the server, remembered across launches, and a new sale told
/// apart only in newest-first order.
@MainActor
@Suite("Sales sort")
struct SalesSortTests {
    @Test
    func `remembers its order, reads in it, and celebrates only in newest-first order`() async throws {
        let defaults = try #require(UserDefaults(suiteName: "SalesSortTests-\(UUID().uuidString)"))
        let service = SortedSalesService(pages: [
            SalePage(sales: [sale(id: "sale-1")], nextCursor: nil),
            SalePage(sales: [sale(id: "sale-2"), sale(id: "sale-1")], nextCursor: "c1"),
        ])
        let list = SalesListModel(service: service, defaults: defaults)
        #expect(list.sort == .soldNewest)
        await list.load()

        list.sort = .profitHigh
        await list.load()
        #expect(service.sorts == [.soldNewest, .profitHigh])
        #expect(list.sales.map(\.id) == ["sale-2", "sale-1"])
        #expect(list.newSaleID == nil, "the first row of another order is not a new sale")
        await list.loadMore()
        #expect(service.sorts.last == .profitHigh, "a cursor continues the order it was read in")

        // The next launch opens in the same order; an order this build doesn't know falls back.
        #expect(SalesListModel(service: service, defaults: defaults).sort == .profitHigh)
        defaults.set("by_vibes", forKey: SaleSort.storageKey)
        #expect(SalesListModel(service: service, defaults: defaults).sort == .soldNewest)
        SalesEnvironment.resetLocalData(defaults: defaults)
        #expect(defaults.string(forKey: SaleSort.storageKey) == nil)
    }
}
