import Foundation
import ListoraAPI
import Testing
@testable import SalesFeature

private typealias Schemas = Components.Schemas

@Suite("Sale row thumbnail")
struct SaleThumbnailTests {
    @Test
    func `a sale row shows its sold item's thumbnail once it has one`() {
        let url = "https://photos.example.com/public/photos/item-1/thumbnail.jpg"
        #expect(SaleThumbnail.url(of: sale(thumbnailUrl: url)) == URL(string: url))
        #expect(SaleThumbnail.url(of: sale(thumbnailUrl: nil)) == nil)
    }
}

private let now = Date(timeIntervalSince1970: 1_792_900_000)

private func usd(_ cents: Int64) -> Schemas.Money {
    .init(amountCents: cents, currency: .usd)
}

private func sale(thumbnailUrl: String?) -> Schemas.Sale {
    .init(
        id: "sale-1",
        marketplace: .init(value1: .mercari),
        items: [.init(
            itemId: "item-1",
            sku: "AJ-000001",
            title: "Wool scarf",
            thumbnailUrl: thumbnailUrl,
            salePrice: usd(1800),
        )],
        soldAt: now,
        salePrice: usd(1800),
        detectionSource: .init(value1: .history),
        status: .init(value1: .shipped),
        availableActions: [],
        isDoubleSale: false,
        delistRuns: [],
        doubleSales: [],
        createdAt: now,
        updatedAt: now,
    )
}
