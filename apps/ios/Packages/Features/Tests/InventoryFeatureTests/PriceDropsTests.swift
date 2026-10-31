import APIClient
import Foundation
import ListoraAPI
import Testing
@testable import InventoryFeature

/// A ``PriceDropService`` that keeps the rules it is sent and can fail.
actor FakePriceDropService: PriceDropService {
    var drops = Components.Schemas.PriceDrops(rules: [], planned: [])
    var defaultsAnswer = Components.Schemas.PriceDropDefaults(percent: 10, afterDays: 21)
    private(set) var created: [Components.Schemas.PriceDropRuleCreate] = []
    private(set) var replaced: [(String, Components.Schemas.PriceDropRuleReplace)] = []
    private(set) var deleted: [String] = []
    private(set) var defaultsAsked: [(String?, String?)] = []
    var failure: APIFailure?

    func set(_ drops: Components.Schemas.PriceDrops) {
        self.drops = drops
    }

    func setDefaults(_ defaults: Components.Schemas.PriceDropDefaults) {
        defaultsAnswer = defaults
    }

    func fail(with failure: APIFailure?) {
        self.failure = failure
    }

    func priceDrops(itemID _: String?) async throws(APIFailure) -> Components.Schemas.PriceDrops {
        if let failure {
            throw failure
        }
        return drops
    }

    func defaults(itemID: String?, brand: String?) async throws(APIFailure) -> Components.Schemas.PriceDropDefaults {
        defaultsAsked.append((itemID, brand))
        if let failure {
            throw failure
        }
        return defaultsAnswer
    }

    func create(_ rule: Components.Schemas.PriceDropRuleCreate) async throws(APIFailure)
        -> Components.Schemas.PriceDropRule
    {
        if let failure {
            throw failure
        }
        created.append(rule)
        return PriceDropFixtures.rule(id: "new", brand: rule.brand, percent: rule.percent)
    }

    func replace(ruleID: String, _ rule: Components.Schemas.PriceDropRuleReplace) async throws(APIFailure)
        -> Components.Schemas.PriceDropRule
    {
        if let failure {
            throw failure
        }
        replaced.append((ruleID, rule))
        drops.rules = drops.rules.map { current in
            guard current.id == ruleID else { return current }
            var changed = current
            changed.enabled = rule.enabled
            changed.percent = rule.percent
            return changed
        }
        return drops.rules.first { $0.id == ruleID } ?? PriceDropFixtures.rule(id: ruleID)
    }

    func delete(ruleID: String) async throws(APIFailure) {
        if let failure {
            throw failure
        }
        deleted.append(ruleID)
    }
}

/// Invented rules and drops (never a real shop's data).
enum PriceDropFixtures {
    static func rule(
        id: String,
        brand: String? = "Patagonia",
        percent: Int32 = 10,
        enabled: Bool = true,
        liveListings: Int32 = 2,
    ) -> Components.Schemas.PriceDropRule {
        .init(
            id: id,
            scope: .init(value1: brand == nil ? .item : .brand),
            itemId: brand == nil ? "item-1" : nil,
            sku: brand == nil ? "AJ-000184" : nil,
            title: brand == nil ? "Fleece pullover" : nil,
            brand: brand,
            percent: percent,
            afterDays: 21,
            floor: .init(amountCents: 2500, currency: .usd),
            enabled: enabled,
            armedAt: Date(timeIntervalSince1970: 1_793_000_000),
            liveListings: liveListings,
        )
    }

    static func drop(
        listing: String,
        state: Components.Schemas.KnownPlannedPriceDropState,
        when: Date? = nil,
        next: Int64? = nil,
    ) -> Components.Schemas.PlannedPriceDrop {
        .init(
            listingId: listing,
            itemId: "item-\(listing)",
            sku: "AJ-0001\(listing)",
            title: "Fleece \(listing)",
            marketplace: .init(value1: .depop),
            ruleId: "rule-1",
            price: .init(amountCents: 4000, currency: .usd),
            state: .init(value1: state),
            at: when,
            nextPrice: next.map { .init(amountCents: $0, currency: .usd) },
        )
    }
}

@Suite("Price drops")
@MainActor
struct PriceDropsTests {
    private let now = Date(timeIntervalSince1970: 1_793_000_000)

    @Test
    func `words a rule's terms, what it is for, and a planned drop`() {
        let brand = PriceDropFixtures.rule(id: "r1")
        #expect(PriceDropWords.terms(brand) == "10% off after 21 days unsold, never below $25.00")
        #expect(PriceDropWords.target(brand) == "Patagonia")
        #expect(PriceDropWords.scopeLine(brand) == "Every Patagonia item without its own rule · 2 live listings")
        let item = PriceDropFixtures.rule(id: "r2", brand: nil)
        #expect(PriceDropWords.target(item) == "Fleece pullover")

        let soon = PriceDropFixtures.drop(listing: "1", state: .scheduled, when: now, next: 3600)
        #expect(PriceDropWords.plan(soon, now: now) == "Drops from $40.00 to $36.00, soon")
        #expect(PriceDropWords.plan(PriceDropFixtures.drop(listing: "2", state: .atFloor), now: now)
            == "At its lowest price, $40.00")
        #expect(PriceDropWords.plan(PriceDropFixtures.drop(listing: "3", state: .lastFailed), now: now)
            == "Paused: its last price change failed. Retry it on the item.")
        #expect(PriceDropWords.days(1) == "1 day")
    }

    @Test
    func `says what a default rests on, or that there are too few sales`() {
        #expect(PriceDropWords.basis(.init(percent: 10, afterDays: 21))
            == "Not enough of your sales yet to go by, so this starts at 21 days.")
        let brand = Components.Schemas.PriceDropDefaults(
            percent: 10,
            afterDays: 18,
            basis: .init(sales: 7, medianDays: 18, brand: "Patagonia"),
        )
        #expect(PriceDropWords.basis(brand) == "Half your Patagonia items sold within 18 days (7 sales this year).")
    }

    @Test
    func `loads the rules and the planned drops, scheduled ones apart from the rest`() async {
        let service = FakePriceDropService()
        await service.set(.init(
            rules: [PriceDropFixtures.rule(id: "r1"), PriceDropFixtures.rule(id: "r2", brand: nil)],
            planned: [
                PriceDropFixtures.drop(listing: "1", state: .scheduled, when: now, next: 3600),
                PriceDropFixtures.drop(listing: "2", state: .atFloor),
            ],
        ))
        let model = PriceDropsModel(service: service)
        await model.load()
        #expect(model.phase == .loaded)
        #expect(model.brandRules.map(\.id) == ["r1"])
        #expect(model.itemRules.map(\.id) == ["r2"])
        #expect(model.scheduled.map(\.listingId) == ["1"])
        #expect(model.waiting.map(\.listingId) == ["2"])
    }

    @Test
    func `turns a rule off with its terms unchanged, and says so when that fails`() async {
        let service = FakePriceDropService()
        let rule = PriceDropFixtures.rule(id: "r1")
        await service.set(.init(rules: [rule], planned: []))
        let model = PriceDropsModel(service: service)
        await model.load()

        await model.setEnabled(false, for: rule)
        let sent = await service.replaced
        #expect(sent.map(\.0) == ["r1"])
        #expect(sent.first?.1 == .init(percent: 10, afterDays: 21, floor: rule.floor, enabled: false))
        #expect(model.rules.first?.enabled == false)

        await service.fail(with: .networkUnavailable)
        await model.setEnabled(true, for: rule)
        #expect(model.rules.first?.enabled == false)
        #expect(model.changeError == "Couldn't turn on this rule. Can't reach Listora. Check your connection.")
    }

    @Test
    func `shows a failed first load, and keeps what showed when a later one fails`() async {
        let service = FakePriceDropService()
        await service.fail(with: .networkUnavailable)
        let model = PriceDropsModel(service: service)
        await model.load()
        #expect(model.phase == .failed(message: "Can't reach Listora. Check your connection."))

        await service.fail(with: nil)
        await service.set(.init(rules: [PriceDropFixtures.rule(id: "r1")], planned: []))
        await model.load()
        await service.fail(with: .networkUnavailable)
        await model.load()
        #expect(model.phase == .loaded)
        #expect(model.rules.map(\.id) == ["r1"])
    }

    @Test
    func `starts a new brand rule from the seller's own days to sell, and saves it`() async {
        let service = FakePriceDropService()
        await service.setDefaults(.init(
            percent: 10,
            afterDays: 16,
            basis: .init(sales: 4, medianDays: 16, brand: "Patagonia"),
        ))
        let editor = PriceDropRuleEditorModel(target: .newBrand, service: service)
        #expect(editor.missing == "Enter the brand as it is on the tag.")
        editor.brand = " Patagonia "
        await editor.loadDefaults()
        #expect(editor.afterDays == 16)
        let asked = await service.defaultsAsked
        #expect(asked.first?.1 == "Patagonia")
        #expect(editor.missing == "Enter the lowest price, at least $1.")
        #expect(await editor.save() == false)

        editor.floorCents = 2500
        #expect(editor.summary == "10% off after 16 days unsold, never below $25.00")
        #expect(await editor.save())
        let created = await service.created
        #expect(created == [.init(
            brand: "Patagonia",
            percent: 10,
            afterDays: 16,
            floor: .init(amountCents: 2500, currency: .usd),
        )])
    }

    @Test
    func `gives an item its own rule with its lowest price as the floor`() async {
        let service = FakePriceDropService()
        await service.setDefaults(.init(percent: 10, afterDays: 21, floor: .init(amountCents: 3000, currency: .usd)))
        let editor = PriceDropRuleEditorModel(target: .newItem(itemID: "item-9", brand: "Levi's"), service: service)
        await editor.loadDefaults()
        #expect(editor.floorCents == 3000)
        let asked = await service.defaultsAsked
        #expect(asked.first?.0 == "item-9")
        #expect(await editor.save())
        let created = await service.created
        #expect(created.first?.itemId == "item-9")
        #expect(created.first?.brand == nil)
    }

    @Test
    func `changes an existing rule, deletes it, and keeps the sheet open on a failure`() async {
        let service = FakePriceDropService()
        let rule = PriceDropFixtures.rule(id: "r1")
        await service.set(.init(rules: [rule], planned: []))
        let editor = PriceDropRuleEditorModel(target: .existing(rule), service: service)
        await editor.loadDefaults()
        #expect(await service.defaultsAsked.isEmpty)
        editor.percent = 20
        #expect(await editor.save())
        #expect(await service.replaced.first?.1.percent == 20)

        await service.fail(with: .networkUnavailable)
        #expect(await editor.delete() == false)
        #expect(editor.saveError == "Can't reach Listora. Check your connection.")
        await service.fail(with: nil)
        #expect(await editor.delete())
        #expect(await service.deleted == ["r1"])
    }
}
