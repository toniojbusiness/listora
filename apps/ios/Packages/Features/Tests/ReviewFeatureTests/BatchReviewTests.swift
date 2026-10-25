import APIClient
import Core
import Foundation
import ListoraAPI
import Testing
@testable import ReviewFeature

/// The batch's rapid review over the scripted server: approve and next, the haul's cost applied
/// to every item, skipping, and what the review reports back to Add Item.
@MainActor
struct BatchReviewTests {
    private let harness = ReviewFlowHarness()

    private func environment() -> ReviewEnvironment {
        ReviewEnvironment(
            service: harness.service,
            meter: harness.meter,
            listingCopy: harness.listingCopy,
            recentSources: RecentPurchaseSources(defaults: harness.defaults),
            transcriber: FakeTranscriber(),
            timing: ReviewFlowHarness.timing,
        )
    }

    /// Every item analyzed already: the server's batch job started each analysis.
    private func scriptAnalyzedItems() async {
        await harness.service.setItems([.success(Fixtures.item())])
        await harness.service.setStarts([
            .success(Fixtures.analysis(status: .completed, result: Fixtures.result())),
        ])
    }

    private func request(items: Int) -> BatchReviewRequest {
        BatchReviewRequest(
            batchID: "batch-1",
            items: (0 ..< items).map { .init(sessionID: "draft-\($0)", itemID: "item-\($0)", sku: "AJ-00018\($0)") },
            batchSessionID: "batch-local-1",
        )
    }

    private func model(items: Int, events: EventLog) -> BatchReviewModel {
        for index in 0 ..< items {
            harness.meter.begin("draft-\(index)")
        }
        harness.meter.begin("batch-local-1")
        return BatchReviewModel(request: request(items: items), environment: environment()) { events.append($0) }
    }

    @Test
    func `approving saves the item at the recommended price and shows the next one`() async throws {
        await scriptAnalyzedItems()
        let events = EventLog()
        let model = model(items: 2, events: events)
        await model.pageAppeared(0)
        let first = try #require(model.current)
        #expect(first.phase == .reviewing)
        // The page loads the prices when it shows; the recommended tier is preselected.
        await first.loadPricing()
        #expect(first.chosenPriceLabel == "$26.00")

        await model.approve(first)

        #expect(first.saved?.price == "$26.00")
        #expect(model.index == 1)
        let replace = try #require(await harness.service.replacements.last)
        #expect(replace.status == .ready)
        #expect(replace.details.listPrice?.amountCents == 2600)
        // The highest "Don't sell below" floor goes with it.
        #expect(replace.details.floorPrice?.amountCents == 1611)
        guard case let .saved(sessionID, itemID, sku, summary) = try #require(events.events.first) else {
            Issue.record("the first event is not a save")
            return
        }
        #expect(sessionID == "draft-0")
        #expect(itemID == "item-0")
        #expect(sku == "AJ-000184")
        #expect(summary != nil)
    }

    @Test
    func `the last approval shows the summary, with the whole batch's time and taps`() async {
        await scriptAnalyzedItems()
        let events = EventLog()
        let model = model(items: 2, events: events)
        for index in 0 ..< 2 {
            await model.pageAppeared(index)
            await model.approve(model.pages[index])
        }
        #expect(model.showsSummary)
        let summary = model.summary
        #expect(summary.saved.count == 2)
        #expect(events.events.count == 2)

        model.finish()
        #expect(events.events.last == .finished)
    }

    @Test
    func `a haul's cost applies to every item left, the same each or split to the cent`() async {
        #expect(BatchReviewModel.amounts(.each(500), count: 3) == [500, 500, 500])
        #expect(BatchReviewModel.amounts(.total(1000), count: 3) == [334, 333, 333])
        #expect(BatchReviewModel.amounts(.total(1000), count: 3).reduce(0, +) == 1000)
        #expect(BatchReviewModel.amounts(.total(1000), count: 0).isEmpty)

        await scriptAnalyzedItems()
        let model = model(items: 3, events: EventLog())
        await model.pageAppeared(0)
        let first = model.pages[0]
        first.cost.amount = AmountEntry(cents: 4000)
        first.cost.source = "Estate sale"
        model.applyCost(from: first, as: .total(4000))

        #expect(model.pages.map(\.cost.amount.cents) == [1334, 1333, 1333])
        #expect(model.pages.map(\.cost.source) == ["Estate sale", "Estate sale", "Estate sale"])
        // Applied: no page offers to apply its share again, until the seller changes it.
        #expect(model.pages.allSatisfy(model.hasAppliedCost))
        model.pages[1].cost.amount.press(.delete)
        #expect(!model.hasAppliedCost(model.pages[1]))
        #expect(model.hasAppliedCost(model.pages[2]))
    }

    @Test
    func `an approved item's cost and source are saved with it`() async throws {
        await scriptAnalyzedItems()
        let model = model(items: 2, events: EventLog())
        await model.pageAppeared(0)
        let first = model.pages[0]
        first.cost.amount = AmountEntry(cents: 800)
        first.cost.source = "Goodwill"

        await model.approve(first)

        let replacements = await harness.service.replacements
        let costSave = try #require(replacements.first { $0.details.cost != nil })
        #expect(costSave.details.cost?.amountCents == 800)
        #expect(costSave.details.purchaseSource == "Goodwill")
        #expect(RecentPurchaseSources(defaults: harness.defaults).sources == ["Goodwill"])
    }

    @Test
    func `skipping leaves the item for later and comes back to it after the others`() async {
        await scriptAnalyzedItems()
        let model = model(items: 3, events: EventLog())
        await model.pageAppeared(0)
        model.skip()
        #expect(model.index == 1)
        await model.pageAppeared(1)
        await model.approve(model.pages[1])
        #expect(model.index == 2)
        await model.pageAppeared(2)
        await model.approve(model.pages[2])
        // The skipped first item is next, not the summary.
        #expect(model.index == 0)
        #expect(!model.showsSummary)
    }

    @Test
    func `a save the server refuses stays on the item with its reason, and reports nothing`() async {
        await scriptAnalyzedItems()
        let events = EventLog()
        let model = model(items: 2, events: events)
        await model.pageAppeared(0)
        await harness.service.setReplaceAnswers([
            .failure(.server(422, "validation_failed", "The title is too long.")),
        ])

        await model.approve(model.pages[0])

        #expect(model.index == 0)
        #expect(model.pages[0].saved == nil)
        #expect(model.pages[0].actionError == "The title is too long.")
        #expect(events.events.isEmpty)
    }

    @Test
    func `only the item showing is measured`() async {
        await scriptAnalyzedItems()
        let model = model(items: 2, events: EventLog())
        model.setVisible(true)
        harness.meter.recordTap()
        model.index = 1
        harness.meter.recordTap()
        harness.meter.recordTap()
        model.setVisible(false)
        harness.meter.recordTap()

        #expect(harness.meter.session("draft-0")?.taps == 1)
        #expect(harness.meter.session("draft-1")?.taps == 2)
    }
}

/// The events a review reported, in order.
@MainActor
final class EventLog {
    private(set) var events: [BatchReviewEvent] = []

    func append(_ event: BatchReviewEvent) {
        events.append(event)
    }
}
