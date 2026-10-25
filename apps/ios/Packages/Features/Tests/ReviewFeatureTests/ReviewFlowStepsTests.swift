import APIClient
import Core
import Foundation
import ListoraAPI
import Testing
@testable import ReviewFeature

/// The review's Continue, the cost, the price, and the save.
@MainActor
struct ReviewFlowStepsTests {
    let harness = ReviewFlowHarness()

    @Test
    func `saves the review, the cost, and the price, then the inventory item ready to list`() async throws {
        await harness.scriptHappyPath()
        let model = harness.model()
        harness.meter.begin(harness.request.sessionID)
        harness.meter.enter(harness.request.sessionID)
        await model.start()
        model.update(.brand, to: .text("Acme"))

        await model.continueToCost()
        #expect(model.showsCost)
        model.cost.amount = AmountEntry(cents: 1200)
        model.cost.source = "Goodwill"
        await model.continueToPrice()
        #expect(model.showsPrice)
        #expect(model.priceChoice == .tier(.recommended))
        #expect(model.chosenCents == 2600)

        await model.save()
        #expect(model.showsSaved)
        let saved = try #require(model.saved)
        #expect(saved.sku == "AJ-000184")
        #expect(saved.price == "$26.00")
        #expect(saved.summary?.sku == "AJ-000184", "the interaction measurement ends with the save")
        #expect(harness.meter.session(harness.request.sessionID) == nil)

        let replacements = await harness.service.replacements
        #expect(replacements.count == 3)
        #expect(replacements[0].details.brand == "Acme")
        #expect(replacements[0].status == nil)
        #expect(replacements[1].details.cost == Fixtures.usd(1200))
        #expect(replacements[1].details.purchaseDate == ReviewFlowModel.day(Fixtures.date))
        #expect(replacements[1].details.purchaseSource == "Goodwill")
        #expect(replacements[1].details.brand == "Acme", "a later step keeps the earlier edits")
        #expect(replacements[2].status == .ready)
        #expect(replacements[2].details.listPrice == Fixtures.usd(2600))
        #expect(replacements[2].details.floorPrice == Fixtures.usd(1611), "the highest floor")
        #expect(replacements[2].details.acceptedAnalysisId == Fixtures.fastID)
        #expect(model.recentSources.sources == ["Goodwill"])
    }

    @Test
    func `the review appearing again under the saved screen keeps the saved item and its measurement`(
    ) async {
        await harness.scriptHappyPath()
        let model = harness.model()
        harness.meter.begin(harness.request.sessionID)
        harness.meter.enter(harness.request.sessionID)
        await model.appeared()
        await model.continueToCost()
        model.cost.amount = AmountEntry(cents: 1200)
        await model.continueToPrice()
        await model.save()
        let calls = await harness.service.calls.count

        // SwiftUI can show the review again while later screens are pushed, restarting its task.
        await model.appeared()

        #expect(model.phase == .reviewing)
        #expect(model.showsSaved)
        #expect(model.saved?.summary?.sku == "AJ-000184", "the measurement the save ended")
        #expect(await harness.service.calls.count == calls, "nothing is loaded again")
    }

    @Test
    func `tapping Continue keeps the text still open in a detail's editor`() async {
        await harness.scriptHappyPath()
        let model = harness.model()
        await model.start()
        model.beginEditing(.brand)
        #expect(model.editing == ReviewFlowModel.FieldDraft(key: .brand, text: "Acme Outfitters"))
        model.editing?.text = "Acme Co. "

        await model.continueToCost()
        #expect(model.editing == nil)
        #expect(model.showsCost)
        #expect(await harness.service.replacements.first?.details.brand == "Acme Co.")
    }

    @Test
    func `opening another detail keeps the text of the one open before`() async {
        await harness.scriptHappyPath()
        let model = harness.model()
        await model.start()
        model.beginEditing(.colors)
        model.editing?.text = "red, navy"
        model.beginEditing(.pattern)
        #expect(model.editing?.key == .pattern)
        #expect(model.form?.field(.colors).value == .list(["red", "navy"]))

        model.commitEditing(.colors)
        #expect(model.editing?.key == .pattern, "a stale editor's commit leaves the open one alone")
    }

    @Test
    func `skipping the cost clears it and the price screen has no floors`() async {
        await harness.scriptHappyPath()
        await harness.service.setPricing([.success(Fixtures.pricing(floors: []))])
        let model = harness.model()
        await model.start()
        await model.continueToCost()
        await model.continueToPrice(skippingCost: true)
        #expect(model.showsPrice)
        #expect(await harness.service.replacements.last?.details.cost == nil)
        guard case let .loaded(presentation) = model.pricing else {
            Issue.record("pricing did not load")
            return
        }
        #expect(presentation.floors.isEmpty)
    }

    @Test
    func `a failed save stays on the screen with the server's reason`() async {
        await harness.scriptHappyPath()
        let model = harness.model()
        await model.start()
        await model.continueToCost()
        model.cost.amount = AmountEntry(cents: 500)
        await model.continueToPrice()
        await harness.service.setReplaceAnswers([.failure(.networkUnavailable)])
        await model.save()
        #expect(!model.showsSaved)
        #expect(model.saved == nil)
        #expect(model.actionError == "Can't reach Listora. Check your connection.")
    }

    @Test
    func `a version conflict reads the item again and saves on top of it`() async {
        await harness.scriptHappyPath()
        let model = harness.model()
        await model.start()
        model.update(.brand, to: .text("Acme"))
        var newer = Fixtures.appliedItem(version: 9)
        newer.details.title = "Renamed on another device"
        await harness.service.setReplaceAnswers([
            .failure(.server(409, "version_conflict", "This item changed. Reload it.")),
            .success(newer),
        ])
        await harness.service.setItems([.success(newer)])
        await model.continueToCost()
        #expect(model.showsCost)
        let replacements = await harness.service.replacements
        #expect(replacements.map(\.expectedVersion) == [3, 9])
        #expect(replacements[1].details.title == "Renamed on another device")
        #expect(replacements[1].details.brand == "Acme")
    }

    @Test
    func `pricing that fails to load can be retried`() async {
        await harness.scriptHappyPath()
        await harness.service.setPricing([.failure(.networkUnavailable), .success(Fixtures.pricing())])
        let model = harness.model()
        await model.start()
        await model.continueToCost()
        model.cost.amount = AmountEntry(cents: 1200)
        await model.continueToPrice()
        #expect(model.pricing == .failed("Can't reach Listora. Check your connection."))
        await model.loadPricing()
        guard case .loaded = model.pricing else {
            Issue.record("pricing did not load on retry")
            return
        }
    }

    @Test
    func `counts the waits as waiting, not as the seller's time`() async throws {
        let clock = TestClock()
        let harness = ReviewFlowHarness(meter: InteractionMeter(storage: InMemoryInteractionStorage()) { clock.now })
        await harness.scriptHappyPath()
        let model = harness.model { _ in await MainActor.run { clock.advance(1) } }
        harness.meter.begin(harness.request.sessionID)
        harness.meter.enter(harness.request.sessionID)
        await model.start()
        clock.advance(5)
        let session = try #require(harness.meter.session(harness.request.sessionID))
        // One poll for the photos and two for the analysis, a second each.
        #expect(session.waiting == 3)
        #expect(session.active == 5)
    }
}
