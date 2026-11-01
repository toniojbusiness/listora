import Core
import Foundation
import Testing
@testable import AddItemFeature

// Invented brands and sales; no real shop's data.

@MainActor
@Suite(.timeLimit(.minutes(1)))
struct SourcingInsightsTests {
    @Test
    func `names each pair by brand and item type, with its sell-through, days, and payout`() {
        let row = SourcingInsightsCard.Row(testInsightGroup())
        #expect(row.title == "Acme jeans")
        #expect(row.detail == "5 of 6 sold · about 9 days to sell · ~$22 after fees")
        #expect(row.stock == "2 in stock now")
    }

    @Test
    func `says only what it knows: no days, no payout, nothing in stock`() {
        let never = SourcingKit.InsightGroup(
            brand: "Thrift Co.",
            brandKey: "thrift",
            category: "bags/other",
            soldCount: 0,
            unsoldCount: 3,
            inStockCount: 0,
            sellThroughBasisPoints: 0,
        )
        let row = SourcingInsightsCard.Row(never)
        #expect(row.title == "Thrift Co. bags")
        #expect(row.detail == "0 of 3 sold")
        #expect(row.stock == nil)

        let fast = SourcingKit.InsightGroup(
            brand: "Acme",
            brandKey: "acme",
            category: "clothing/tops/t_shirts",
            soldCount: 3,
            unsoldCount: 0,
            inStockCount: 0,
            sellThroughBasisPoints: 10000,
            medianDaysToSell: 0,
        )
        #expect(SourcingInsightsCard.Row(fast).detail == "3 of 3 sold · sold within a day")
    }

    @Test
    func `says what the insights rest on, and when there are none`() throws {
        let insights = try #require(testKit().insights)
        let card = SourcingInsightsCard(insights)
        #expect(!card.isEmpty)
        #expect(card.lookFor.map(\.title) == ["Acme jeans"])
        let expected = "From your 5 sales with a brand and item type, and what's in stock."
            + " Days to sell from the 3 Listora listed."
        #expect(card.basedOn == expected)

        let none = SourcingKit.Insights(soldCount: 1, daysToSellCount: 0, lookFor: [], best: [], worst: [])
        let empty = SourcingInsightsCard(none)
        #expect(empty.isEmpty)
        #expect(empty.basedOn == "From your 1 sale with a brand and item type, and what's in stock.")
    }

    @Test
    func `names what to look for on Scan mode's row, or what the screen holds`() {
        #expect(SourcingInsightsLink.subtitle(testKit().insights) == "Look for Acme jeans")
        #expect(SourcingInsightsLink.subtitle(nil) == "Your best and slowest sellers, by brand and item type")
    }

    @Test
    func `fetches the kit for the screen before any run, with signal only, and keeps its insights`() async throws {
        let directory = try TemporaryDirectory()
        let file = directory.url.appending(path: "sourcing-kit.json")
        let service = FakeScanService()
        service.answer(kit: testKit())
        let connectivity = FakeConnectivity(online: false)
        let runs = ScanRuns(
            dependencies: ScanRunDependencies(
                service: service,
                tagReader: FakeTagReader(),
                connectivity: connectivity,
                saveDraft: { _, _ in nil },
            ),
            directory: directory.url.appending(path: "runs"),
            kit: SourcingKitCache(file: file),
        )
        await runs.refreshKit()
        #expect(service.calls.kits == 0)

        connectivity.set(online: true)
        await runs.refreshKit()
        #expect(service.calls.kits == 1)
        #expect(runs.kit.kit?.insights == testKit().insights)
        // Kept for the store, where there may be no signal.
        #expect(SourcingKitCache(file: file).kit?.insights == testKit().insights)
    }
}
