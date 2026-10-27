import APIClient
import Foundation
import ListoraAPI
import Testing
@testable import InventoryFeature

@MainActor
@Suite("Item activity")
struct ItemActivityModelTests {
    @Test
    func `the item's activity reads in the server's words, with who did it, steps, and times`() async {
        let service = FakeInventoryService()
        let session = Fixtures.activity(
            id: "browser_session:1",
            kind: .browserSession,
            source: .iphone,
            outcome: .failed,
            title: "Your iPhone ran “end” on eBay",
            detail: "Stopped at “find Delete listing”: the page wasn't what Listora knows.",
            durationMs: 12340,
            steps: [.init(name: "open the listing", durationMs: 850), .init(name: "find Delete listing")],
        )
        service.activityPages = [
            ActivityPage(
                entries: [session, Fixtures.activity(id: "operation:1", outcome: .succeeded)],
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
        let first = model.rows.first
        #expect(first?.source == "On your iPhone")
        #expect(first?.tone == .failed)
        #expect(first?.systemImage == "iphone")
        #expect(first?.duration == "12.3 s")
        #expect(first?.steps == [
            .init(name: "open the listing", duration: "850 ms"),
            .init(name: "find Delete listing", duration: nil),
        ])
        // Only a confirmed outcome looks done.
        #expect(model.rows.map(\.tone) == [.failed, .success])
        #expect(model.hasMore)
        await model.loadMore()
        #expect(model.rows.map(\.id) == ["browser_session:1", "operation:1", "sale:1"])
        #expect(model.rows.last?.source == "eBay")
        #expect(!model.hasMore)
        #expect(service.calls.suffix(2) == ["activity", "activity:c1"])
        #expect(ActivityRowContent.duration(milliseconds: 125_000) == "2 min 5 s")
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
