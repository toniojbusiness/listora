import APIClient
import Core
import Foundation
import ListoraAPI
import Testing
@testable import InventoryFeature

@MainActor
@Suite("Inventory models")
struct InventoryModelsTests {
    @Test
    func `loads the newest items and the brands to filter by, and pages on`() async {
        let service = FakeInventoryService()
        service.pages = [
            ItemPage(items: [Fixtures.summary(id: "a", sku: "AJ-2", brand: "Levi's")], nextCursor: "c1"),
            ItemPage(items: [Fixtures.summary(id: "b", sku: "AJ-1", brand: "levi's")], nextCursor: nil),
        ]
        let model = InventoryListModel(service: service)
        await model.load()
        #expect(model.phase == .loaded)
        #expect(model.items.map(\.sku) == ["AJ-2"])
        #expect(model.hasMore)
        await model.loadMore()
        #expect(model.items.map(\.sku) == ["AJ-2", "AJ-1"])
        #expect(model.brands == ["Levi's"])
        #expect(!model.hasMore)
    }

    @Test
    func `sends the filters, and says when nothing loads`() async {
        let service = FakeInventoryService()
        let model = InventoryListModel(service: service)
        model.query.marketplace = .ebay
        model.query.brand = "Levi's"
        #expect(model.isFiltered)
        service.failure = .networkUnavailable
        await model.load()
        #expect(model.phase == .failed(message: "Can't reach Listora. Check your connection."))
        #expect(service.queries.last?.marketplace == .ebay)
        model.clearFilters()
        #expect(!model.isFiltered)
    }

    @Test
    func `rows follow the item's listings, and an action is sent then read back`() async {
        let service = FakeInventoryService()
        service.item = Fixtures.item(listings: [Fixtures.listing()])
        let model = ItemDetailModel(itemID: Fixtures.itemID, service: service, timing: .fast)
        await model.load()
        #expect(model.rows.map(\.id) == ["ebay", "depop", "poshmark", "mercari"])
        #expect(model.rows[0].statusLabel == "Active (confirmed by eBay)")
        #expect(model.rows[1].statusLabel == "Not listed")

        await model.perform(.end(listingID: Fixtures.listingID, reason: .notAvailable), marketplace: "ebay")
        #expect(service.calls.suffix(2) == ["perform", "item"])
        #expect(model.notice == nil)
    }

    @Test
    func `sends an action again with the same key when its answer was lost, and shows a refusal`() async {
        let service = FakeInventoryService()
        service.item = Fixtures.item(listings: [Fixtures.listing()])
        let model = ItemDetailModel(itemID: Fixtures.itemID, service: service, timing: .fast)
        await model.load()
        service.failure = .networkUnavailable
        await model.perform(.verify(listingID: Fixtures.listingID), marketplace: "ebay")
        let keys = service.requests.map(\.1)
        #expect(keys.count == 2)
        #expect(Set(keys).count == 1)
        #expect(model.notice == nil)

        service.failure = APIFailure(
            statusCode: 409,
            code: "invalid_state_transition",
            message: "Not now.",
            retryable: false,
        )
        await model.retry(operationID: Fixtures.operationID, marketplace: "ebay")
        #expect(model.notice == "Not now.")
        #expect(service.calls.contains("retry:\(Fixtures.operationID)"))
    }

    @Test
    func `starts the eBay listing from the seller's edit, else the analysis, else the item`() async throws {
        let directory = URL.temporaryDirectory.appending(path: UUID().uuidString)
        let store = ListingCopyStore(directory: directory)
        let service = FakeInventoryService()
        service.variants = [.init(
            marketplace: Fixtures.marketplace(.ebay),
            title: "Analysis title",
            description: "Analysis copy.",
        )]

        let fromAnalysis = ListingFlowModel(
            item: Fixtures.item(acceptedAnalysis: true),
            service: service,
            listingCopy: store,
        )
        await fromAnalysis.prepare()
        #expect(fromAnalysis.title == "Analysis title")
        #expect(fromAnalysis.priceCents == 4500)
        #expect(fromAnalysis.selected == ["ebay"])
        #expect(fromAnalysis.choices.filter(\.isAvailable).map(\.id) == ["ebay"])

        try store.save(
            ListingCopy(title: "My title", description: "Mine."),
            marketplace: "ebay",
            itemID: Fixtures.itemID,
        )
        let fromEdit = ListingFlowModel(
            item: Fixtures.item(acceptedAnalysis: true),
            service: service,
            listingCopy: store,
        )
        await fromEdit.prepare()
        #expect(fromEdit.title == "My title")

        let plain = ListingFlowModel(
            item: Fixtures.item(),
            service: service,
            listingCopy: ListingCopyStore(directory: directory.appending(path: "x")),
        )
        await plain.prepare()
        #expect(plain.title == "Levi's Trucker Denim Jacket")
    }

    @Test
    func `publishes a draft, and keeps the draft when eBay would refuse it`() async {
        let service = FakeInventoryService()
        let store = ListingCopyStore(directory: URL.temporaryDirectory.appending(path: UUID().uuidString))
        let model = ListingFlowModel(item: Fixtures.item(), service: service, listingCopy: store)
        await model.prepare()
        model.next()
        #expect(model.step == .review)

        model.title = String(repeating: "A", count: 81)
        #expect(await model.publish() == false)
        #expect(model.problem == "The title is 81 characters; eBay allows 80.")
        #expect(service.calls.isEmpty)

        model.title = "Levi's Trucker Denim Jacket Men's M"
        service.failingCall = "perform"
        service.failure = APIFailure(
            statusCode: 422,
            code: "validation_failed",
            message: "eBay needs at least one photo.",
            retryable: false,
        )
        #expect(await model.publish() == false)
        #expect(model.problem == "eBay needs at least one photo.")
        // The second try updates the same draft, then publishes it.
        #expect(await model.publish())
        #expect(service.calls == ["create", "perform", "replace", "perform"])
        // A refusal is final for its key, so the second publish sends a new one.
        #expect(Set(service.requests.map(\.1)).count == 2)
        #expect(service.variantsSent.last?.price.amountCents == 4500)
        #expect(service.variantsSent.last?.condition == .preOwnedExcellent)
    }
}

extension DetailTiming {
    static let fast = DetailTiming(
        poll: .milliseconds(10),
        longestPoll: .milliseconds(50),
        sendAttempts: 3,
        sendRetryDelay: .milliseconds(1),
    )
}
