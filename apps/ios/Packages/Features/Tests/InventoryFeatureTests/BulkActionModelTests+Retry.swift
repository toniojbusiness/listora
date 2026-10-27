import ListoraAPI
import Testing
@testable import InventoryFeature

/// List on a draft the server won't publish anew (``BulkActionModel/list(_:on:)``).
extension BulkActionModelTests {
    @Test
    func `sends a draft whose listing failed again by its Retry, and leaves a running one alone`() async {
        let service = FakeInventoryService()
        service.connectionList = [
            Fixtures.connection(.poshmark, mode: "automation"),
            Fixtures.connection(.depop, mode: "automation"),
        ]
        // The server takes no new draft for a listing that may have reached the marketplace:
        // its draft offers no List, only the failed try's Retry.
        var failed = listing(.poshmark, id: "l1", status: .draft, actions: [])
        failed.latestOperation = Fixtures.operation(
            kind: .create, status: .failed, label: "Failed", tone: .failed,
        )
        var running = listing(.depop, id: "l2", status: .draft, actions: [])
        running.latestOperation = Fixtures.operation(
            kind: .create, status: .running, label: "Listing", tone: .inProgress,
        )
        let model = model(service, [item("a", sku: "AJ-1", listings: [failed, running])])
        await model.prepare()
        await model.run(.list(marketplaces: ["poshmark", "depop"]))
        #expect(Set(results(model)) == [
            "AJ-1 poshmark started: Listing on Poshmark started again. It shows as listed once Poshmark confirms.",
            "AJ-1 depop skipped: Still working on the last change on Depop. Try again once it's done.",
        ])
        let sent = service.calls.filter { ["create", "replace", "perform"].contains($0) || $0.hasPrefix("retry") }
        #expect(sent == ["retry:\(Fixtures.operationID)"], "no new draft, no publish")

        var unfixable = failed
        unfixable.latestOperation = Fixtures.operation(
            kind: .create, status: .failed, label: "Failed", tone: .failed, retryable: false,
        )
        let refused = self.model(service, [item("b", sku: "AJ-2", listings: [unfixable])])
        await refused.prepare()
        await refused.run(.list(marketplaces: ["poshmark"]))
        #expect(results(refused) == ["AJ-2 poshmark skipped: Listing on Poshmark failed. Open the item to see why."])
    }
}
