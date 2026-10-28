import APIClient
import ListoraAPI
import Testing
@testable import InventoryFeature

/// Delete, and what it does with a listing that may be live (``DeleteMode``).
extension BulkActionModelTests {
    @Test
    func `counts the items still listed somewhere, so Delete asks what to do with their listings`() {
        let service = FakeInventoryService()
        let model = model(service, [
            item("a", sku: "AJ-1", listings: [listing(.ebay, id: "l1", actions: [.end])]),
            item("b", sku: "AJ-2", listings: [
                listing(.poshmark, id: "l2", status: .draft, actions: []),
                listing(.depop, id: "l3", status: .ended, actions: []),
                listing(.mercari, id: "l4", status: .sold, actions: []),
            ]),
            item("c", sku: "AJ-3", listings: [listing(.poshmark, id: "l5", status: .unknown, actions: [])]),
        ])
        #expect(model.listedItems == 2, "a draft, ended, or sold listing is not on its marketplace")
    }

    @Test
    func `removes an item from Listora only, leaving its listings up`() async {
        let service = FakeInventoryService()
        let model = model(service, [
            item("a", sku: "AJ-1", listings: [listing(.ebay, id: "l1", actions: [.end])]),
            item("b", sku: "AJ-2"),
        ])
        await model.run(.delete(.leaveListings))
        #expect(results(model) == [
            "AJ-1 item done: Removed from Listora. Its listings stay up.",
            "AJ-2 item done: Deleted.",
        ])
        #expect(service.calls.filter { $0.hasPrefix("delete") } == [
            "delete:a:leavingListings",
            "delete:b:leavingListings",
        ])
        #expect(service.requests.isEmpty, "nothing changes on a marketplace")
    }

    @Test
    func `ends the live listings first, then deletes the item once its marketplaces confirm`() async {
        let service = FakeInventoryService()
        let ended = item("a", sku: "AJ-1", listings: [
            listing(.ebay, id: "l1", status: .ended, actions: [.relist]),
            listing(.poshmark, id: "l2", status: .draft, actions: []),
        ])
        let model = model(service, [
            item("a", sku: "AJ-1", listings: [
                listing(.ebay, id: "l1", actions: [.end]),
                listing(.poshmark, id: "l2", status: .draft, actions: []),
            ]),
            item("b", sku: "AJ-2", listings: [listing(.depop, id: "l3", status: .ended, actions: [])]),
        ])
        service.onPerform = { [service] _ in service.itemsByID["a"] = ended }
        await model.run(.delete(.endListingsFirst))
        #expect(results(model) == [
            "AJ-1 ebay done: Ended on eBay.",
            "AJ-1 item done: Deleted.",
            "AJ-2 item done: Deleted.",
        ])
        #expect(service.requests.map(\.0) == [.end(listingID: "l1", reason: EndReason.notAvailable.contract)])
        #expect(Set(service.deleted) == ["a", "b"], "items run side by side")
    }

    @Test
    func `keeps an item whose listing didn't end, and says what is left`() async {
        let service = FakeInventoryService()
        var ending = listing(.mercari, id: "l3", status: .ending, actions: [])
        ending.latestOperation = Fixtures.operation(status: .running, label: "Delisting...", tone: .inProgress)
        let model = model(service, [item("a", sku: "AJ-1", listings: [
            listing(.poshmark, id: "l1", actions: [.end]),
            listing(.ebay, id: "l2", actions: [.end]),
            ending,
        ])])
        // Poshmark refuses the end; eBay takes it but the listing stays up; Mercari is still ending.
        service.failure = APIFailure(
            statusCode: 409,
            code: "connection_read_only",
            message: "Your Poshmark account is read only in Listora.",
            retryable: false,
        )
        service.failingCall = "perform"
        await model.run(.delete(.endListingsFirst))
        #expect(results(model) == [
            "AJ-1 ebay failed: Still listed on eBay (Active (confirmed by eBay)). End it from the item, or remove "
                + "the item from Listora only.",
            "AJ-1 poshmark failed: Your Poshmark account is read only in Listora.",
            "AJ-1 mercari started: Ending on Mercari. Delete the item again once it has ended.",
            "AJ-1 item skipped: Kept in Listora while it's still listed.",
        ])
        #expect(service.requests.map(\.0) == [
            .end(listingID: "l1", reason: EndReason.notAvailable.contract),
            .end(listingID: "l2", reason: EndReason.notAvailable.contract),
        ], "a listing still ending gets no second end")
        #expect(service.deleted.isEmpty, "an item still listed is never deleted")
    }
}
