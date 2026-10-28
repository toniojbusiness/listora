import APIClient
import DesignSystem
import Foundation
import ListoraAPI
import Testing
@testable import TodayFeature

struct TodayCardContentTests {
    /// Noon on Sunday, 25 October 2026, in UTC.
    private let now = Date(timeIntervalSince1970: 1_792_929_600)
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        return calendar
    }

    private func ship(shipBy: String?, location: [String: Any]? = ["code": "B-12", "label": "Garage shelf 3"])
        throws -> TodayCardContent
    {
        var shipment: [String: Any] = [
            "saleId": "sale-1", "marketplace": "ebay", "soldAt": "2026-10-24T09:00:00Z",
        ]
        shipment["shipBy"] = shipBy
        shipment["location"] = location
        return try TodayCardContent(
            card(id: "ship:1", kind: "ship", urgency: "urgent", title: "Ship Levi's 501", extra: [
                "item": ["id": "item-1", "sku": "AJ-000001", "thumbnailUrl": "https://cdn.example.com/t.jpg"],
                "shipment": shipment,
            ]),
            now: now,
            calendar: calendar,
        )
    }

    @Test
    func `a ship card says when to ship by and where the item is kept, and opens the item`() throws {
        let content = try ship(shipBy: "2026-10-25T20:00:00Z")
        #expect(content.title == "Ship Levi's 501")
        #expect(content.urgency == .init(label: "Urgent", tone: .actionNeeded))
        #expect(content.facts == [
            .init(text: "Ship by today", systemImage: "calendar"),
            .init(text: "B-12 · Garage shelf 3", systemImage: "archivebox"),
        ])
        #expect(content.thumbnailURL == URL(string: "https://cdn.example.com/t.jpg"))
        #expect(content.action == .init(label: "Open item", destination: .item(id: "item-1")))
    }

    @Test
    func `the ship-by date reads tomorrow, as a day, as overdue, or as when it sold`() throws {
        #expect(try ship(shipBy: "2026-10-26T20:00:00Z").facts.first?.text == "Ship by tomorrow")
        #expect(try ship(shipBy: "2026-10-30T20:00:00Z").facts.first?.text == "Ship by Fri, Oct 30")
        let overdue = try ship(shipBy: "2026-10-24T20:00:00Z").facts.first
        #expect(overdue == .init(
            text: "Overdue since Oct 24",
            systemImage: "exclamationmark.circle",
            tone: .actionNeeded,
        ))
        #expect(try ship(shipBy: nil, location: nil).facts == [.init(text: "Sold Oct 24", systemImage: "calendar")])
    }

    @Test
    func `a delist card shows the server's honest status once, not twice`() throws {
        let content = try TodayCardContent(
            card(
                kind: "delist",
                urgency: "high",
                title: "Coat sold on Depop",
                detail: "Delisting on Poshmark...",
                action: ["label": "View delisting", "destination": "item", "itemId": "item-2"],
                extra: ["delist": [
                    "saleId": "sale-2", "delistRunId": "run-2", "soldOn": "depop",
                    "statusDisplay": ["tone": "in_progress", "label": "Delisting on Poshmark..."],
                    "remaining": ["poshmark"],
                ]],
            ),
            now: now,
        )
        #expect(content.status == .init(label: "Delisting on Poshmark...", tone: .inProgress))
        #expect(content.detail == nil)
        #expect(content.urgency == .init(label: "Soon", tone: .neutral))
    }

    @Test
    func `reconnect opens the marketplaces, drafts open the drafts, and a stale listing shows its age`() throws {
        let reconnect = try TodayCardContent(
            card(kind: "reconnect", action: ["label": "Reconnect", "destination": "marketplaces", "connectionId": "c"]),
            now: now,
        )
        #expect(reconnect.action?.destination == .marketplaces)
        let drafts = try TodayCardContent(
            card(
                kind: "review_drafts",
                action: ["label": "Review drafts", "destination": "drafts"],
                extra: ["drafts": ["count": 2, "oldestCreatedAt": "2026-10-20T08:00:00Z"]],
            ),
            now: now,
        )
        #expect(drafts.action?.destination == .drafts)
        #expect(drafts.facts == [.init(text: "Oldest from Oct 20", systemImage: "calendar")])
        let stale = try TodayCardContent(
            card(kind: "stale_listing", extra: ["staleListing": [
                "listedAt": "2026-09-10T08:00:00Z", "daysListed": 45, "price": usd(4500), "floor": usd(3500),
                "suggestion": "price_drop", "suggestedPrice": usd(4000), "marketplaces": ["ebay", "poshmark"],
            ]]),
            now: now,
        )
        #expect(stale.facts.map(\.text) == ["Listed 45 days", "eBay, Poshmark"])
        #expect(stale.urgency == nil)
    }

    @Test
    func `a ship card opens its sale, or its item when the sale is not named`() throws {
        let sale = try TodayCardContent(
            card(kind: "ship", action: [
                "label": "Open sale", "destination": "sale", "itemId": "item-1", "saleId": "sale-1",
            ]),
            now: now,
        )
        #expect(sale.action == .init(label: "Open sale", destination: .sale(id: "sale-1")))
        let unnamed = try TodayCardContent(
            card(kind: "ship", action: ["label": "Open sale", "destination": "sale", "itemId": "item-1"]),
            now: now,
        )
        #expect(unnamed.action?.destination == .item(id: "item-1"))
    }

    @Test
    func `a card or destination this app does not know still shows, and opens its item if it names one`() throws {
        let unknown = try TodayCardContent(
            card(kind: "tax_reminder", action: ["label": "Open", "destination": "taxes", "itemId": "item-9"]),
            now: now,
        )
        #expect(unknown.systemImage == "sparkles")
        #expect(unknown.action?.destination == .item(id: "item-9"))
        let nowhere = try TodayCardContent(
            card(kind: "ship", action: ["label": "Open", "destination": "taxes"]),
            now: now,
        )
        #expect(nowhere.action == nil)
    }
}

struct MoneySummaryContentTests {
    private func money(this: [String: Any], last: [String: Any]) throws -> MoneySummaryContent {
        try MoneySummaryContent(decode(Components.Schemas.TodayMoney.self, ["thisWeek": this, "lastWeek": last]))
    }

    @Test
    func `compares this week's sales with last week's and shows the known profit`() throws {
        let content = try money(
            this: period(sales: 3, total: 14200, profit: 6150, without: 1),
            last: period(sales: 2, total: 9800, profit: 4100),
        )
        #expect(content.sales == "$142")
        #expect(content.itemsSold == "3 items sold")
        #expect(content.comparison == .init(
            text: "$44 more than last week",
            systemImage: "arrow.up.right",
            tone: .success,
        ))
        #expect(content.profit == "$61.50")
        #expect(content.profitNote == "Not counting 1 sale whose fees or cost aren't in yet.")
        #expect(content.hasSales)
    }

    @Test
    func `never shows a profit the server does not know`() throws {
        let content = try money(
            this: period(sales: 1, total: 2000, profit: nil, without: 1),
            last: period(sales: 2, total: 5000, profit: 1000),
        )
        #expect(content.profit == nil)
        #expect(content.profitNote == "Shows once each sale's fees and item costs are in.")
        #expect(content.comparison.text == "$30 less than last week")
    }

    @Test
    func `has nothing to say without sales in either week`() throws {
        let content = try money(
            this: period(sales: 0, total: 0, profit: 0),
            last: period(sales: 0, total: 0, profit: 0),
        )
        #expect(!content.hasSales)
        #expect(content.comparison.text == "Same as last week")
    }
}

@MainActor
struct TodayModelTests {
    private let newYork = TimeZone(identifier: "America/New_York") ?? .current

    @Test
    func `loads the cards in the server's order, and is caught up without any`() async throws {
        let first = try today(cards: [card(id: "a", kind: "ship"), card(id: "b", kind: "reconnect")])
        let empty = try today(cards: [])
        let service = FakeTodayService(todays: [.success(first), .success(empty)])
        let model = TodayModel(service: service, timeZone: { newYork })
        #expect(model.phase == .loading)
        await model.load()
        #expect(model.phase == .loaded)
        #expect(model.cards.map(\.id) == ["a", "b"])
        #expect(!model.isCaughtUp)
        await model.load()
        #expect(model.isCaughtUp)
    }

    @Test
    func `keeps the cards when a later load fails, and fails plainly on the first`() async throws {
        let loaded = try today(cards: [card(id: "a", kind: "ship")])
        let service = FakeTodayService(todays: [.success(loaded)])
        let model = TodayModel(service: service)
        await model.load()
        await model.load()
        #expect(model.phase == .loaded)
        #expect(model.cards.map(\.id) == ["a"])

        let offline = TodayModel(service: FakeTodayService())
        await offline.load()
        #expect(offline.phase == .failed(message: "Can't reach Listora. Check your connection."))
    }

    @Test
    func `asks nothing of the server while signed out, and signs out on a refused session`() async {
        let service = FakeTodayService()
        let signedOut = TodayModel(service: service, isSignedIn: { false })
        await signedOut.load()
        #expect(signedOut.phase == .signedOut)

        let refused = APIFailure(statusCode: 401, code: "unauthenticated", message: "Sign in.", retryable: false)
        let expired = TodayModel(service: FakeTodayService(todays: [.failure(refused)]))
        await expired.load()
        #expect(expired.phase == .signedOut)
    }

    @Test
    func `tells the server this device's time zone once, keeping the seller's choices`() async throws {
        let empty = try today(cards: [])
        let service = FakeTodayService(
            todays: [.success(empty), .success(empty)],
            settings: .success(.init(enabled: false, time: "07:15", timeZone: "UTC")),
        )
        let model = TodayModel(service: service, timeZone: { newYork })
        await model.load()
        await model.load()
        #expect(service.saved.count == 1)
        #expect(service.saved.first?.enabled == false)
        #expect(service.saved.first?.time == "07:15")
        #expect(service.saved.first?.timeZone == "America/New_York")
    }

    @Test
    func `leaves the setting alone when the time zone already matches`() async throws {
        let empty = try today(cards: [])
        let service = FakeTodayService(
            todays: [.success(empty)],
            settings: .success(.init(enabled: true, time: "08:00", timeZone: "America/New_York")),
        )
        await TodayModel(service: service, timeZone: { newYork }).load()
        #expect(service.saved.isEmpty)
    }
}

@MainActor
struct SummarySettingsModelTests {
    @Test
    func `loads the setting and saves it with this device's time zone`() async {
        let zone = TimeZone(identifier: "Europe/Paris") ?? .current
        let service = FakeTodayService(settings: .success(.init(enabled: true, time: "06:45", timeZone: "UTC")))
        let model = SummarySettingsModel(service: service, timeZone: { zone })
        await model.load()
        #expect(model.phase == .loaded)
        #expect(model.time == DateComponents(hour: 6, minute: 45))
        model.isEnabled = false
        model.time = DateComponents(hour: 9, minute: 5)
        #expect(await model.save())
        #expect(service.saved.first?.enabled == false)
        #expect(service.saved.first?.time == "09:05")
        #expect(service.saved.first?.timeZone == "Europe/Paris")
    }

    @Test
    func `shows why a save failed`() async {
        let refused = APIFailure(statusCode: 422, code: "validation_failed", message: "Bad zone.", retryable: false)
        let service = FakeTodayService(saves: [.failure(refused)])
        let model = SummarySettingsModel(service: service)
        await model.load()
        #expect(await model.save() == false)
        #expect(model.saveError == "Bad zone.")
    }

    @Test
    func `reads and writes times as HH:MM`() {
        #expect(SummarySettingsModel.components("08:05") == DateComponents(hour: 8, minute: 5))
        #expect(SummarySettingsModel.components("24:00") == nil)
        #expect(SummarySettingsModel.components("noon") == nil)
        #expect(SummarySettingsModel.text(DateComponents(hour: 7, minute: 0)) == "07:00")
    }
}
