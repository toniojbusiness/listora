import APIClient
import Core
import Foundation
import ListoraAPI
import Testing
@testable import ReviewFeature

/// The cost screen's "Part of a haul" (docs/features/hauls.md): a new haul's total and count, a
/// saved haul picked again, the count fixed, leaving a haul for the item's own price, and how a
/// haul reads.
@MainActor
struct HaulCostTests {
    let harness = ReviewFlowHarness()

    private func atCost() async -> ReviewFlowModel {
        await harness.scriptHappyPath()
        let model = harness.model()
        await model.start()
        await model.continueToCost()
        return model
    }

    @Test
    func `a haul reads as each item's share of its total`() {
        #expect(HaulPresentation.eachCents(totalCents: 5000, count: 30) == 167)
        #expect(HaulPresentation.eachCents(totalCents: 1000, count: 3) == 333)
        #expect(HaulPresentation.eachCents(totalCents: 1001, count: 2) == 501)
        #expect(HaulPresentation.summary(eachCents: 167, totalCents: 5000, count: 30)
            == "$1.67 each, from a $50 haul of 30")
        #expect(HaulPresentation.choice(Fixtures.haul()) == "$50 haul of 30, Goodwill Bins")
        #expect(HaulPresentation.money(1250) == "$12.50")
    }

    @Test
    func `the count takes digits only, with no leading zero and at most 10,000`() {
        var count = CountEntry()
        count.press(.digit(0))
        #expect(count.isEmpty)
        count.press(.digit(3))
        count.press(.decimalPoint)
        count.press(.digit(0))
        #expect(count.value == 30)
        count.press(.digit(0))
        count.press(.digit(0))
        count.press(.digit(0))
        #expect(count.value == 3000, "a count over 10,000 is not typed")
        count.press(.delete)
        #expect(count.value == 300)
        #expect(CountEntry(20000).value == 10000)
    }

    @Test
    func `a new haul is created with the item in it, and the item's share is its cost`() async throws {
        let model = await atCost()
        model.cost.mode = .haul
        #expect(!model.cost.isComplete, "the total and the count are needed")
        model.cost.haulTotal = AmountEntry(cents: 5000)
        model.cost.haulField = .count
        model.cost.haulCount.press(.digit(3))
        model.cost.haulCount.press(.digit(0))
        model.cost.source = "Goodwill Bins"
        #expect(model.cost.isComplete)
        #expect(model.haulSummary == "$1.67 each, from a $50 haul of 30")

        await model.continueToPrice()

        #expect(model.showsPrice)
        let created = try #require(await harness.service.haulCreates.first)
        #expect(created.total == Fixtures.usd(5000))
        #expect(created.itemCount == 30)
        #expect(created.itemIds == [Fixtures.itemID])
        #expect(created.purchaseSource == "Goodwill Bins")
        #expect(created.purchaseDate == ReviewFlowModel.day(Fixtures.date))
        // The server set the cost; the app never writes a haul item's cost itself.
        #expect(await harness.service.replacements.allSatisfy { $0.details.cost == nil })
        #expect(model.cost.amount.cents == 167)
        #expect(model.item?.haul?.id == "haul-1")
        #expect(model.cost.haul?.id == "haul-1")
        #expect(model.recentHauls.first?.id == "haul-1")
        #expect(model.recentSources.sources == ["Goodwill Bins"])
    }

    @Test
    func `a retry of the same new haul reuses its key, so it is recorded once`() async {
        let model = await atCost()
        await harness.service.setCreateHaulAnswers([
            .failure(.server(503, "unavailable", "Try again.", retryable: true)),
            .success(Fixtures.haul()),
        ])
        model.cost.mode = .haul
        model.cost.haulTotal = AmountEntry(cents: 5000)
        model.cost.haulCount = CountEntry(30)

        await model.continueToPrice()
        #expect(!model.showsPrice)
        #expect(model.actionError == "Try again.")
        await model.continueToPrice()
        #expect(model.showsPrice)

        let keys = await harness.service.calls.compactMap { call -> String? in
            if case let .createHaul(key) = call {
                return key
            }
            return nil
        }
        #expect(keys.count == 2)
        #expect(Set(keys).count == 1)
    }

    @Test
    func `a saved haul is picked again for the next item from the trip`() async throws {
        await harness.service.setHauls([Fixtures.haul(added: 4)])
        let model = await atCost()
        await model.loadHauls()
        let haul = try #require(model.recentHauls.first)
        model.cost.mode = .haul
        model.cost.haul = haul
        #expect(model.cost.isComplete)
        #expect(model.haulSummary == "$1.67 each, from a $50 haul of 30")

        await model.continueToPrice()

        #expect(model.showsPrice)
        let calls = await harness.service.calls
        #expect(calls.contains(.addHaulItems(haulID: "haul-1", itemIDs: [Fixtures.itemID])))
        #expect(await harness.service.haulCreates.isEmpty)
        // The fifth item to join: 5000 = 30 x 166 + 20, so it carries a leftover cent.
        #expect(model.cost.amount.cents == 167)
    }

    @Test
    func `the seller fixes a saved haul's count, and the item gets its new share`() async {
        await harness.service.setHauls([Fixtures.haul(added: 0)])
        let model = await atCost()
        await model.loadHauls()
        model.cost.mode = .haul
        model.cost.haul = model.recentHauls.first
        await model.continueToPrice()
        #expect(model.cost.amount.cents == 167)

        model.cost.haulCount = CountEntry(25)
        await model.fixHaulCount()

        #expect(await harness.service.calls.contains(.replaceHaul(haulID: "haul-1", count: 25)))
        #expect(model.cost.haul?.itemCount == 25)
        #expect(model.cost.amount.cents == 200)
        #expect(model.haulSummary == "$2.00 each, from a $50 haul of 25")
    }

    @Test
    func `choosing this item takes it out of its haul before saving its own price`() async throws {
        await harness.service.setHauls([Fixtures.haul(added: 0)])
        let model = await atCost()
        await model.loadHauls()
        model.cost.mode = .haul
        model.cost.haul = model.recentHauls.first
        await model.continueToPrice()
        #expect(model.item?.haul != nil)

        model.cost.mode = .item
        model.cost.amount = AmountEntry(cents: 900)
        await model.continueToPrice()

        let calls = await harness.service.calls
        let removed = try #require(calls.firstIndex(of: .removeHaulItem(haulID: "haul-1")))
        let saved = try #require(calls.lastIndex(where: {
            if case .replace = $0 {
                return true
            }
            return false
        }))
        #expect(removed < saved, "the item leaves the haul before its own cost is saved")
        #expect(await harness.service.replacements.last?.details.cost == Fixtures.usd(900))
    }

    @Test
    func `an item already in a haul reopens on its haul`() async {
        var item = Fixtures.appliedItem()
        item.haul = Fixtures.haul()
        item.details.cost = Fixtures.usd(167)
        await harness.scriptHappyPath()
        await harness.service.setApplies([.success(item)])
        let model = harness.model()
        await model.start()
        #expect(model.cost.mode == .haul)
        #expect(model.cost.haul?.id == "haul-1")
        #expect(model.cost.amount.cents == 167)
    }
}
