import Foundation
import Testing
@testable import AddItemFeature

/// Prices after the facts (docs/features/thrift-scan.md): the card says what the item is at once
/// and holds the verdict and every price until the server has what they rest on; then it leads
/// with the verdict and its why, the three prices, and the reality check.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct ScanPricesTests {
    private func makeRun(_ service: FakeScanService) -> ScanRunModel {
        ScanRunModel(
            service: service,
            tagReader: FakeTagReader(),
            directory: FileManager.default.temporaryDirectory.appending(path: "scan-prices-\(UUID().uuidString)"),
            saveDraft: { _, _ in "draft-1" },
        )
    }

    private func capture(_ seed: UInt64 = 1) -> Data {
        TestImages.jpeg(width: 1600, height: 1200, seed: seed)
    }

    @Test
    func `says what the item is at once and holds the verdict and every price while they wait`() throws {
        let card = try ScanCard(decodeScan(heldScanJSON(id: "scan-1", waitingOn: ["web", "depop"])))
        #expect(card.pricesPending)
        #expect(card.needsPrices)
        #expect(card.call == .checking)
        #expect(card.title == "Lululemon black high-rise leggings")
        #expect(card.subtitle == "Size 6 · Nylon · Vintage 1990s · Pre-owned good")
        #expect(card.readConfidence == "Sure of what it is")
        #expect(card.pricingLabel == "Checking prices: the web, Depop")
        #expect(card.why == nil)
        #expect(card.prices == nil)
        #expect(card.range == nil)
        #expect(card.ownSales.isEmpty)
        #expect(card.aiEstimate == nil)
        #expect(card.haptic == nil)
        #expect(card.tone == .neutral)
    }

    @Test
    func `leads with the verdict and its why, then the prices and the reality check`() throws {
        let card = try ScanCard(decodeScan(pricedScanJSON(id: "scan-1", missing: ["Couldn't check the web in time"])))
        #expect(!card.pricesPending)
        #expect(!card.needsPrices || card.pricingLabel != nil)
        #expect(card.callLabel == "Maybe")
        #expect(card.verdictNote == "Your call")
        #expect(card.tone == .actionNeeded)
        #expect(card.why == "Pays out $22-$26 after fees, but often faked: check it's real")
        #expect(card.prices?.realistic == "$28")
        #expect(card.realityCheck.map(\.kind) == ["own_sales", "retail", "missing"])
        #expect(card.missing == ["Couldn't check the web in time"])
        #expect(try ScanCard(decodeScan(pricedScanJSON(id: "scan-2", call: "buy"))).verdictNote == nil)
        #expect(try ScanCard(decodeScan(pricedScanJSON(id: "scan-3", call: "buy"))).tone == .success)
        #expect(try ScanCard(decodeScan(pricedScanJSON(id: "scan-4", call: "skip"))).tone == .failed)
    }

    @Test
    func `asks for held prices at once, and the card takes them in when they come`() async throws {
        let service = FakeScanService()
        let run = makeRun(service)
        service.answer(scanJSON: heldScanJSON(id: "scan-1"))
        try service.answerResearch(JSONSerialization.data(withJSONObject: pricedScanJSON(id: "scan-1", call: "buy")))
        await run.shoot(capture())
        #expect(try await eventually { run.current?.research == .done })
        #expect(service.researched == ["scan-1"])
        let card = try #require(run.current?.card)
        #expect(!card.pricesPending)
        #expect(card.callLabel == "Grab")
        #expect(card.prices?.listAt == "$35")
    }

    @Test
    func `keeps Keep and Put back while the prices wait, and asks again when they failed`() async throws {
        let service = FakeScanService()
        let run = makeRun(service)
        service.answer(scanJSON: heldScanJSON(id: "scan-1"))
        await run.shoot(capture())
        // No scripted answer: the ask fails, and the card stays on what the item is.
        #expect(try await eventually { run.current?.research == .failed })
        #expect(run.current?.card?.pricesPending == true)
        try service.answerResearch(JSONSerialization.data(withJSONObject: pricedScanJSON(id: "scan-1")))
        try run.retryPrices(#require(run.currentID))
        #expect(try await eventually { run.current?.research == .done })
        #expect(run.current?.card?.callLabel == "Maybe")
        #expect(service.researched == ["scan-1", "scan-1"])
        // Put back is there whatever the prices are doing: the card closes at once.
        service.answer(scanJSON: heldScanJSON(id: "scan-2"))
        await run.shoot(capture(2))
        #expect(run.current?.card?.pricesPending == true)
        try run.putBack(#require(run.currentID))
        #expect(run.current == nil)
        #expect(run.confirmationLine?.text == "Put back · none kept yet")
    }
}
