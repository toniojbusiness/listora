import APIClient
import Foundation
import ListoraAPI
import Testing
@testable import InventoryFeature

@MainActor
@Suite("Item activity")
struct ItemActivityModelTests {
    @Test
    func `the item's activity reads in the server's words, with who did it and when`() async {
        let service = FakeInventoryService()
        let delist = Fixtures.activity(
            id: "operation:1",
            source: .iphone,
            outcome: .failed,
            title: "Delist on eBay after the sale",
            detail: "eBay didn't take the change. Listora will try again.",
        )
        service.activityPages = [
            ActivityPage(
                entries: [delist, Fixtures.activity(id: "operation:2", outcome: .succeeded)],
                nextCursor: "c1",
            ),
            ActivityPage(
                entries: [Fixtures.activity(id: "sale:1", kind: .sale, source: .marketplace)],
                nextCursor: nil,
            ),
        ]
        let model = ItemActivityModel(itemID: Fixtures.itemID, service: service)
        await model.load()
        #expect(model.phase == .loaded)
        // Where Listora ran it (this iPhone, its cloud browser) is Listora's, not the seller's.
        #expect(model.rows.first?.source == "Listora")
        // Only a confirmed outcome looks done.
        #expect(model.rows.map(\.tone) == [.failed, .success])
        #expect(model.hasMore)
        await model.loadMore()
        #expect(model.rows.map(\.id) == ["operation:1", "operation:2", "sale:1"])
        #expect(model.rows.last?.source == "eBay")
        #expect(!model.hasMore)
        #expect(service.calls.suffix(2) == ["activity", "activity:c1"])
    }

    @Test
    func `the item's activity says plainly when it can't load, and keeps what it showed`() async {
        let service = FakeInventoryService()
        service.failure = .networkUnavailable
        let model = ItemActivityModel(itemID: Fixtures.itemID, service: service)
        await model.load()
        guard case .failed = model.phase else {
            Issue.record("expected a failure, got \(model.phase)")
            return
        }
        service.activityPages = [ActivityPage(entries: [Fixtures.activity(id: "operation:1")], nextCursor: nil)]
        await model.load()
        #expect(model.rows.map(\.id) == ["operation:1"])
        service.failure = .networkUnavailable
        await model.load()
        #expect(model.phase == .loaded)
        #expect(model.rows.map(\.id) == ["operation:1"])
    }
}
