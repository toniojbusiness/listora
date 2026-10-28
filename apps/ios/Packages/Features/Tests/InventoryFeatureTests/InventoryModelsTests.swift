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
    func `warns when a new price is below the marketplace's floor, and only then`() async {
        let service = FakeInventoryService()
        let usd = { (cents: Int64) in Schemas.Money(amountCents: cents, currency: .usd) }
        let breakdown = Schemas.FloorBreakdown(
            cost: usd(1250), estimatedFees: usd(244), shipping: usd(0), minimumProfit: usd(0),
        )
        let floor = { (marketplace: Schemas.KnownMarketplace, cents: Int64) in
            Schemas.MarketplaceFloor(
                marketplace: .init(value1: marketplace), floorPrice: usd(cents), breakdown: breakdown,
                feeTableVersion: "t",
            )
        }
        service.floorList = [floor(.ebay, 1494), floor(.poshmark, 1563)]
        let model = ItemDetailModel(itemID: Fixtures.itemID, service: service, timing: .fast)
        let ebayFloor = await model.floor(on: "ebay")
        #expect(ebayFloor?.amountCents == 1494)
        #expect(await model.floor(on: "depop") == nil)

        #expect(
            PriceChangeView.floorWarning(cents: 1000, floor: ebayFloor, marketplace: "eBay")
                == "Below your $14.94 floor on eBay, so you would make less than your minimum after fees.",
        )
        #expect(PriceChangeView.floorWarning(cents: 1494, floor: ebayFloor, marketplace: "eBay") == nil)
        #expect(PriceChangeView.floorWarning(cents: 1000, floor: nil, marketplace: "eBay") == nil, "no cost, no floor")
        service.failure = .networkUnavailable
        #expect(await model.floor(on: "ebay") == nil, "a failed read only drops the warning")
    }

    @Test
    func `saves the size the marketplaces asked for, again on the newest version after a conflict`() async {
        let service = FakeInventoryService()
        var item = Fixtures.item()
        item.details.sizeLabel = nil
        service.item = item
        let model = ItemDetailModel(itemID: Fixtures.itemID, service: service, timing: .fast)
        await model.load()

        #expect(await model.saveSize("  M ") == nil)
        #expect(service.replaced.last?.details.sizeLabel == "M")
        #expect(service.replaced.last?.expectedVersion == item.version)
        #expect(model.item?.details.sizeLabel == "M")
        #expect(model.item?.details.title == item.details.title, "the other details are kept")

        // Changed elsewhere meanwhile: read again, and the size goes on the newest version.
        service.failingCall = "replaceItem"
        service.failure = APIFailure(statusCode: 409, code: "version_conflict", message: "Changed.", retryable: false)
        #expect(await model.saveSize("L") == nil)
        #expect(service.replaced.map(\.details.sizeLabel) == ["M", "L", "L"])
        #expect(model.item?.details.sizeLabel == "L")

        // Any other refusal is shown, and nothing changes.
        service.failure = APIFailure(statusCode: 422, code: "validation_failed", message: "Too long.", retryable: false)
        #expect(await model.saveSize(String(repeating: "X", count: 40)) == "Too long.")
        #expect(model.item?.details.sizeLabel == "L")
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
        #expect(fromAnalysis.selected == ["ebay"])
        // eBay through its API; the others assisted, through a task.
        #expect(fromAnalysis.choices.filter(\.isAvailable).map(\.id) == ["ebay", "depop", "poshmark", "mercari"])
        #expect(fromAnalysis.choices.filter(\.isAssisted).map(\.id) == ["depop", "poshmark", "mercari"])
        await fromAnalysis.next()
        #expect(fromAnalysis.title == "Analysis title")
        #expect(fromAnalysis.priceCents == 4500)
        #expect(fromAnalysis.sendTitle == "Publish to eBay")

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
        await fromEdit.next()
        #expect(fromEdit.title == "My title")

        let plain = ListingFlowModel(
            item: Fixtures.item(),
            service: service,
            listingCopy: ListingCopyStore(directory: directory.appending(path: "x")),
        )
        await plain.prepare()
        await plain.next()
        #expect(plain.title == "Levi's Trucker Denim Jacket")
    }

    @Test
    func `publishes a draft, and keeps the draft when eBay would refuse it`() async {
        let service = FakeInventoryService()
        let store = ListingCopyStore(directory: URL.temporaryDirectory.appending(path: UUID().uuidString))
        let model = ListingFlowModel(item: Fixtures.item(), service: service, listingCopy: store)
        await model.prepare()
        await model.next()
        #expect(model.step == .review)

        model.title = String(repeating: "A", count: 81)
        #expect(await model.publish() == false)
        #expect(model.problem == "The title is 81 characters; eBay allows 80.")
        #expect(service.calls.isEmpty)

        model.title = "Levi's Trucker Denim Jacket Men's M"
        #expect(model.problem == nil, "fixing the title clears the old refusal")
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

    @Test
    func `lists on an assisted marketplace through a task, after eBay, each reviewed in turn`() async {
        let service = FakeInventoryService()
        let store = ListingCopyStore(directory: URL.temporaryDirectory.appending(path: UUID().uuidString))
        try? store.save(
            ListingCopy(title: "Posh title", description: "Posh copy."),
            marketplace: "poshmark",
            itemID: Fixtures.itemID,
        )
        let model = ListingFlowModel(
            item: Fixtures.item(),
            service: service,
            listingCopy: store,
            marketplace: "poshmark",
        )
        await model.prepare()
        #expect(model.selected == ["poshmark"])
        model.selected.insert("ebay")
        await model.next()

        #expect(model.queue.map(\.id) == ["ebay", "poshmark"])
        #expect(model.current?.id == "ebay")
        #expect(model.titleLimit == 80)
        #expect(await model.publish() == false)
        #expect(model.step == .review)
        #expect(model.current?.id == "poshmark")
        #expect(model.sendTitle == "Create Poshmark task")
        #expect(model.titleLimit == nil)
        #expect(model.title == "Posh title")

        model.title = String(repeating: "A", count: 120)
        #expect(await model.publish())
        #expect(service.createdOn == ["ebay", "poshmark"])
        #expect(service.calls == ["create", "perform", "create", "perform"])
    }

    @Test
    func `does not offer a marketplace the item is already on, or eBay without its connection`() async {
        let service = FakeInventoryService()
        service.connectionList = []
        var posh = Fixtures.listing(label: "Done (you confirmed)", actions: [.end])
        posh.marketplace = Fixtures.marketplace(.poshmark)
        let model = ListingFlowModel(
            item: Fixtures.item(listings: [posh]),
            service: service,
            listingCopy: ListingCopyStore(directory: URL.temporaryDirectory.appending(path: UUID().uuidString)),
        )
        await model.prepare()
        #expect(model.choices.filter(\.isAvailable).map(\.id) == ["depop", "mercari"])
        #expect(model.choices.first { $0.id == "ebay" }?.detail == "Connect eBay in Settings > Marketplaces first")
        #expect(model.choices.first { $0.id == "poshmark" }?
            .detail == "Already on Poshmark. Change it from the item screen.")
        #expect(model.selected.isEmpty)
        #expect(!model.canContinue)
    }
}

extension DetailTiming {
    static let fast = DetailTiming(
        poll: .milliseconds(10),
        longestPoll: .milliseconds(50),
        sendAttempts: 3,
        sendRetryDelay: .milliseconds(1),
        endWait: .milliseconds(200),
    )
}
