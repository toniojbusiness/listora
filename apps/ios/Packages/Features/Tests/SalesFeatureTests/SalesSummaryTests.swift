import APIClient
import Foundation
import ListoraAPI
import Testing
@testable import SalesFeature

private typealias Schemas = Components.Schemas

/// The test services that script no summary fail it: the list works without one.
extension SalesService {
    func summary() async throws(APIFailure) -> Components.Schemas.SalesSummary {
        throw .networkUnavailable
    }
}

/// A ``SalesService`` whose list and summary answer in turn; nothing else is asked of it.
private final class SummaryService: SalesService, @unchecked Sendable {
    private let lock = NSLock()
    private var summaries: [Result<Schemas.SalesSummary, APIFailure>]

    init(summaries: [Result<Schemas.SalesSummary, APIFailure>]) {
        self.summaries = summaries
    }

    func summary() async throws(APIFailure) -> Schemas.SalesSummary {
        let next = lock.withLock { summaries.isEmpty ? .failure(.networkUnavailable) : summaries.removeFirst() }
        return try next.get()
    }

    func sales(sort _: SaleSort, cursor _: String?) async throws(APIFailure) -> SalePage {
        SalePage(sales: [], nextCursor: nil)
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

/// All sales: some on Depop, none yet on Poshmark (connected).
private func salesSummary(depopCents: Int64, depopSales: Int32) -> Schemas.SalesSummary {
    let money = { (cents: Int64) in Schemas.Money(amountCents: cents, currency: .usd) }
    return Schemas.SalesSummary(
        total: .init(salesCount: depopSales, itemsSold: depopSales + 3, revenue: money(depopCents)),
        marketplaces: [
            .init(
                marketplace: .init(value1: .depop),
                salesCount: depopSales,
                itemsSold: depopSales + 3,
                revenue: money(depopCents),
            ),
            .init(marketplace: .init(value1: .poshmark), salesCount: 0, itemsSold: 0, revenue: money(0)),
        ],
        firstSoldAt: Date(timeIntervalSince1970: 1_790_000_000),
    )
}

@MainActor
struct SalesSummaryTests {
    @Test
    func `the list reads the sales in total and per marketplace, and keeps the last when a read fails`() async {
        let first = salesSummary(depopCents: 81200, depopSales: 41)
        let list = SalesListModel(service: SummaryService(summaries: [.success(first), .failure(.networkUnavailable)]))
        await list.load()
        #expect(list.summary == first)
        // The next read of it fails: the list still loads, with the summary it had.
        await list.load()
        #expect(list.phase == .loaded)
        #expect(list.summary == first)
    }

    @Test
    func `counts the sales, then the items when a bundle made them more, and since when`() {
        #expect(SalesSummaryView.counts(1, 1, since: nil) == "1 sale")
        #expect(SalesSummaryView.counts(41, 44, since: nil) == "41 sales, 44 items")
        let since = SalesSummaryView.counts(2, 2, since: Date(timeIntervalSince1970: 1_790_000_000))
        #expect(since.hasPrefix("2 sales, since "))
    }
}
