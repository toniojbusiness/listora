import APIClient
import Core
import Foundation
import ListoraAPI
import Testing
@testable import InventoryFeature

@MainActor
@Suite("Bulk actions")
struct BulkActionModelTests {
    let copy = ListingCopyStore(directory: URL.temporaryDirectory.appending(path: "Bulk-\(UUID().uuidString)"))

    func item(
        _ id: String,
        sku: String,
        title: String? = "Levi's jacket",
        listPrice: Int64? = 4500,
        listings: [Schemas.Listing] = [],
    ) -> Schemas.Item {
        var item = Fixtures.item(listings: listings)
        item.id = id
        item.sku = sku
        item.details.title = title
        item.details.listPrice = listPrice.map(Fixtures.usd)
        return item
    }

    func listing(
        _ marketplace: Schemas.KnownMarketplace,
        id: String,
        status: Schemas.KnownListingStatus = .active,
        actions: [Schemas.KnownListingAction],
        price: Int64 = 3900,
    ) -> Schemas.Listing {
        var listing = Fixtures.listing(
            status: status,
            actions: actions,
            variant: .init(title: "Levi's jacket", description: "Blue.", price: Fixtures.usd(price)),
        )
        listing.id = id
        listing.marketplace = Fixtures.marketplace(marketplace)
        return listing
    }

    func model(_ service: FakeInventoryService, _ items: [Schemas.Item]) -> BulkActionModel {
        service.itemsByID = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
        return BulkActionModel(
            items: items.map { ItemSummary($0) },
            service: service,
            listingCopy: copy,
            timing: .fast,
        )
    }

    func results(_ model: BulkActionModel) -> [String] {
        model.outcomes.map { "\($0.sku) \($0.marketplace ?? "item") \($0.result): \($0.message)" }
    }

    @Test
    func `lists every item where it can go, and says why it skipped the rest`() async {
        let service = FakeInventoryService()
        service.connectionList = [
            Fixtures.connection(.ebay, mode: "api"),
            Fixtures.connection(.poshmark, mode: "automation"),
        ]
        let onEbay = item("a", sku: "AJ-1", listings: [listing(.ebay, id: "l1", actions: [.end])])
        let untitled = item("b", sku: "AJ-2", title: nil)
        let unpriced = item("c", sku: "AJ-3", listPrice: nil)
        let model = model(service, [onEbay, untitled, unpriced])
        await model.prepare()
        // Listora lists itself on eBay and Poshmark; Depop and Mercari are offered as tasks.
        #expect(model.chosen == ["ebay", "poshmark"])
        #expect(model.destinations.first { $0.id == "mercari" }?.isAssisted == true)

        await model.run(.list(marketplaces: model.chosen))
        #expect(model.phase == .finished)
        #expect(results(model) == [
            "AJ-1 ebay skipped: Already on eBay.",
            "AJ-1 poshmark started: Listing on Poshmark started. It shows as listed once Poshmark confirms.",
            "AJ-2 ebay skipped: Add a title to the item first.",
            "AJ-2 poshmark skipped: Add a title to the item first.",
            "AJ-3 ebay skipped: Add a price to the item first.",
            "AJ-3 poshmark skipped: Add a price to the item first.",
        ])
        #expect(service.createdOn == ["poshmark"])
        #expect(service.variantsSent.first?.categoryRef == "Men > Tops > T-shirts", "the mapped category")
        #expect(service.requests.count == 1, "one publish")
        #expect(model.summary == "1 started, 5 skipped")
    }

    @Test
    func `asks for a category or a shorter eBay title instead of guessing, and a task where it lists by hand`() async {
        let service = FakeInventoryService()
        service.categories = Schemas.MarketplaceCategories(likely: [], choices: [])
        let long = item("a", sku: "AJ-1", title: String(repeating: "Denim ", count: 20))
        let model = model(service, [long])
        await model.prepare()
        await model.run(.list(marketplaces: ["ebay", "mercari"]))
        #expect(results(model) == [
            "AJ-1 ebay skipped: The title is longer than eBay's 80 characters. List it from the item to shorten it.",
            "AJ-1 mercari skipped: Choose its Mercari category: list it from the item.",
        ])

        service.categories = nil
        let short = item("b", sku: "AJ-2")
        let assisted = self.model(service, [short])
        await assisted.prepare()
        await assisted.run(.list(marketplaces: ["mercari"]))
        #expect(results(assisted) == ["AJ-2 mercari started: Task added: post it in the Mercari app."])
    }

    @Test
    func `ends only what is live, and a refusal names its marketplace`() async {
        let service = FakeInventoryService()
        let live = item("a", sku: "AJ-1", listings: [
            listing(.ebay, id: "l1", actions: [.changePrice, .end]),
            listing(.poshmark, id: "l2", status: .ended, actions: [.relist]),
        ])
        let none = item("b", sku: "AJ-2")
        let model = model(service, [live, none])
        await model.run(.end(.soldElsewhere))
        #expect(results(model) == [
            "AJ-1 ebay started: Ending on eBay started.",
            "AJ-2 item skipped: Not live anywhere, so nothing to end.",
        ])
        #expect(service.requests.map(\.0) == [.end(listingID: "l1", reason: .soldElsewhere)])

        service.failure = APIFailure(
            statusCode: 409,
            code: "invalid_state_transition",
            message: "Not now.",
            retryable: false,
        )
        service.failingCall = "perform"
        let relist = self.model(service, [live])
        await relist.run(.relist)
        #expect(results(relist) == ["AJ-1 poshmark failed: Not now."])
    }

    @Test
    func `says a listing still busy with its last change takes the next one later`() async {
        let service = FakeInventoryService()
        var busy = listing(.ebay, id: "l1", actions: [])
        busy.latestOperation = Fixtures.operation(
            kind: .price,
            status: .verifying,
            label: "Checking...",
            tone: .checking,
        )
        let model = model(service, [item("a", sku: "AJ-1", listings: [busy])])
        await model.run(.end(.notAvailable))
        #expect(results(model) == [
            "AJ-1 ebay skipped: Still working on the last change on eBay. Try again once it's done.",
        ])
        #expect(service.requests.isEmpty)
    }

    @Test
    func `changes each live price and the list price by the same rule, never below a floor`() async {
        let service = FakeInventoryService()
        let floor = Schemas.MarketplaceFloor(
            marketplace: .init(value1: .poshmark),
            floorPrice: Fixtures.usd(3700),
            breakdown: .init(
                cost: Fixtures.usd(800),
                estimatedFees: Fixtures.usd(800),
                shipping: Fixtures.usd(0),
                minimumProfit: Fixtures.usd(0),
            ),
            feeTableVersion: "t",
        )
        service.floorList = [floor]
        let live = item("a", sku: "AJ-1", listings: [
            listing(.ebay, id: "l1", actions: [.changePrice, .end], price: 3900),
            listing(.poshmark, id: "l2", actions: [.changePrice, .end], price: 3900),
        ])
        let model = model(service, [live])
        await model.run(.changePrice(PriceAdjustment(direction: .lower, unit: .percent, value: 10)))
        #expect(results(model) == [
            "AJ-1 ebay started: Changing to $35.10 on eBay. It shows once eBay confirms.",
            "AJ-1 poshmark skipped: $35.10 is below your $37.00 floor on Poshmark. "
                + "Change it from the item if you're sure.",
            "AJ-1 item done: List price is now $40.50.",
        ])
        #expect(service.requests.map(\.0) == [.changePrice(listingID: "l1", price: Fixtures.usd(3510))])
        #expect(service.replaced.last?.details.listPrice == Fixtures.usd(4050))
    }

    @Test
    func `deletes each item, and Try again reruns only what failed`() async {
        let service = FakeInventoryService()
        let model = model(service, [item("a", sku: "AJ-1"), item("b", sku: "AJ-2")])
        service.failure = .networkUnavailable
        service.failingCall = "delete:b"
        await model.run(.delete)
        // A lost answer is sent again with the same key; this one never got through.
        #expect(model.outcomes.map(\.result) == [.done, .done], "the resend went through")

        service.failure = APIFailure(
            statusCode: 409,
            code: "invalid_state_transition",
            message: "This item is live on a marketplace. End its listings before deleting it.",
            retryable: false,
        )
        service.failingCall = "delete:b"
        await model.run(.delete)
        #expect(results(model) == [
            "AJ-1 item done: Deleted.",
            "AJ-2 item failed: This item is live on a marketplace. End its listings before deleting it.",
        ])
        await model.retryFailed()
        #expect(results(model) == ["AJ-1 item done: Deleted.", "AJ-2 item done: Deleted."])
        #expect(service.deleted.filter { $0 == "a" }.count == 2, "the first run and the second, not the retry")
    }

    @Test
    func `a price rule rounds to the cent and never reaches $0`() {
        #expect(PriceAdjustment(direction: .lower, unit: .percent, value: 15).apply(to: 3999) == 3399)
        #expect(PriceAdjustment(direction: .raise, unit: .amount, value: 500).apply(to: 3999) == 4499)
        #expect(PriceAdjustment(direction: .lower, unit: .amount, value: 4000).apply(to: 3999) == nil)
        #expect(PriceAdjustment(direction: .lower, unit: .percent, value: 0).apply(to: 3999) == nil)
        #expect(PriceAdjustment(direction: .lower, unit: .amount, value: 500).summary == "$5.00 lower")
    }

    @Test
    func `the quick filters ask the server for the statuses, and Needs you for what needs the seller`() async {
        #expect(InventoryFilter.sold.statuses == [.soldPendingDelist, .sold, .shipped])
        #expect(InventoryFilter.needsYou.needsAttention)
        #expect(InventoryFilter.all.statuses.isEmpty)
        let service = FakeInventoryService()
        service.pages = [ItemPage(items: [Fixtures.summary(id: "a", sku: "AJ-1")], nextCursor: "next")]
        let attention = InventoryAttention(service: service, isSignedIn: { true })
        await attention.refresh()
        #expect(attention.total == 1)
        #expect(attention.hasMore)
        #expect(service.queries.last?.filter == .needsYou)
        #expect(InventoryAttention(service: service, isSignedIn: { false }).total == 0)
    }

    @Test
    func `selecting chooses items, all of them at once, and forgets those a reload drops`() async {
        let service = FakeInventoryService()
        let first = Fixtures.summary(id: "a", sku: "AJ-1")
        let second = Fixtures.summary(id: "b", sku: "AJ-2")
        service.pages = [ItemPage(items: [first, second]), ItemPage(items: [second])]
        let list = InventoryListModel(service: service)
        await list.load()
        list.startSelecting(with: "a")
        #expect(list.selection == ["a"])
        list.toggleAll()
        #expect(list.allSelected)
        #expect(list.selectedItems.map(\.id) == ["a", "b"])
        await list.load()
        #expect(list.selection == ["b"])
        list.stopSelecting()
        #expect(!list.isSelecting && list.selection.isEmpty)
    }
}
