import Foundation
import ListoraAPI
import Testing
@testable import SalesFeature

private typealias Schemas = Components.Schemas

private let checkedAt = Date(timeIntervalSince1970: 1_800_000_000)

func saleExplanation() -> Components.Schemas.SaleExplanation {
    .init(
        saleId: "sale-1",
        marketplace: .init(value1: .mercari, value2: "mercari"),
        soldAt: checkedAt.addingTimeInterval(-3600),
        recordedAt: checkedAt.addingTimeInterval(60),
        detectionSource: .init(value1: .poll, value2: "poll"),
        detection: "Listora found it on Mercari.",
        check: .init(
            id: "check-1",
            kind: .init(value1: .scheduled, value2: "scheduled"),
            host: .init(value1: .phone, value2: "phone"),
            startedAt: checkedAt,
            ordersSeen: 3,
        ),
        delists: [
            .init(
                itemId: "item-1",
                marketplace: .init(value1: .depop, value2: "depop"),
                status: .init(value1: .succeeded, value2: "succeeded"),
                result: "Delisted (confirmed by Depop).",
                startedAt: checkedAt.addingTimeInterval(61),
                settledAt: checkedAt.addingTimeInterval(120),
            ),
        ],
        entries: [],
    )
}

@Suite("How Listora found a sale")
struct FoundSectionTests {
    @Test
    func `says when it sold, never which check saw it, where, or how long anything took`() {
        let content = FoundSectionContent(saleExplanation())
        #expect(content.facts.map(\.label) == ["Sold"])
    }
}
