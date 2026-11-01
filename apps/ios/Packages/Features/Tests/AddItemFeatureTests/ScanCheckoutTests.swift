import APIClient
import Core
import Foundation
import Testing
@testable import AddItemFeature

// Invented runs, places, and prices; no real shop's data.

@MainActor
@Suite(.timeLimit(.minutes(1)))
struct ScanCheckoutTests {
    /// 2026-10-31 at 23:30 in Los Angeles, already 2026-11-01 in UTC.
    private static let lateEvening = Date(timeIntervalSince1970: 1_793_514_600)

    private func makeRun(_ service: FakeScanService, place: String? = nil) -> ScanRunModel {
        ScanRunModel(
            service: service,
            tagReader: FakeTagReader(),
            directory: FileManager.default.temporaryDirectory.appending(path: "scan-checkout-\(UUID().uuidString)"),
            place: place,
            saveDraft: { _, scanID in "draft-\(scanID)" },
        )
    }

    private func makeCheckout(_ run: ScanRunModel, _ service: FakeScanService) -> ScanCheckoutModel {
        ScanCheckoutModel(run: run, service: service, now: { Self.lateEvening })
    }

    private func capture(_ seed: UInt64 = 1) -> Data {
        TestImages.jpeg(width: 1600, height: 1200, seed: seed)
    }

    @Test
    func `starts the server run at the place the seller named, or none`() async {
        let service = FakeScanService()
        let run = makeRun(service, place: "  Goodwill Outlet ")
        #expect(run.place == "Goodwill Outlet")
        await run.shoot(capture())
        #expect(service.calls.places == ["Goodwill Outlet"])

        let unnamed = FakeScanService()
        let blank = makeRun(unnamed, place: "   ")
        #expect(blank.place == nil)
        await blank.shoot(capture())
        #expect(unnamed.calls.places == [nil])
    }

    @Test
    func `checks out with the kept scans, this iPhone's date, and the miles, then ends the run`() async throws {
        let service = FakeScanService()
        let run = makeRun(service, place: "Goodwill Outlet")
        let checkout = makeCheckout(run, service)
        #expect(!checkout.canCheckOut)
        await run.shoot(capture())
        let first = try #require(run.current)
        await run.shoot(capture(2))
        await run.keep(first.id)
        #expect(checkout.canCheckOut)

        await checkout.checkout(
            totalCents: 2000,
            itemCount: 4,
            miles: 8,
            otherSpend: [RunSpend(category: "Parking", amountCents: 300)],
        )

        let sent = try #require(service.calls.checkouts.first)
        #expect(sent.checkout.otherSpend == [RunSpend(category: "Parking", amountCents: 300)])
        #expect(sent.runID == "run-1")
        #expect(sent.checkout.totalCents == 2000)
        #expect(sent.checkout.itemCount == 4)
        #expect(sent.checkout.miles == 8)
        #expect(sent.checkout.place == "Goodwill Outlet")
        // Only the kept scan; the one skipped by the next shot stays out.
        #expect(sent.checkout.keptScanIDs == [first.scanID].compactMap(\.self))
        #expect(sent.checkout.purchaseDate == ScanCheckoutModel.localDate(Self.lateEvening))
        #expect(checkout.summary?.profitEstimate != nil)
        #expect(checkout.failure == nil)
        #expect(run.isEnded)
        // An ended run takes no more shots and cannot be checked out again.
        await run.shoot(capture(3))
        #expect(run.entries.count == 2)
        #expect(!checkout.canCheckOut)
        await makeCheckout(run, service).checkout(totalCents: 2000, itemCount: 4, miles: nil)
        #expect(service.calls.checkouts.count == 1)
    }

    @Test
    func `a failed checkout says why, shows nothing as checked out, and retries as the same checkout`() async {
        let service = FakeScanService()
        service.answerCheckout(failure: .networkUnavailable)
        let run = makeRun(service)
        let checkout = makeCheckout(run, service)
        await run.shoot(capture())

        await checkout.checkout(totalCents: 500, itemCount: 1, miles: nil)
        #expect(checkout.failure == APIFailure.networkUnavailable.message)
        #expect(checkout.summary == nil)
        #expect(!run.isEnded)
        #expect(checkout.canCheckOut)

        await checkout.checkout(totalCents: 500, itemCount: 1, miles: nil)
        #expect(checkout.failure == nil)
        #expect(checkout.summary != nil)
        let keys = service.calls.checkouts.map(\.key)
        #expect(keys.count == 2)
        #expect(Set(keys).count == 1)
    }

    @Test
    func `refuses a negative total or no items before asking Listora`() async {
        let service = FakeScanService()
        let run = makeRun(service)
        let checkout = makeCheckout(run, service)
        await run.shoot(capture())
        await checkout.checkout(totalCents: -1, itemCount: 1, miles: nil)
        await checkout.checkout(totalCents: 100, itemCount: 0, miles: nil)
        #expect(service.calls.checkouts.isEmpty)
    }

    @Test
    func `uses the day on this iPhone, not UTC's, as the purchase date`() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        #expect(ScanCheckoutModel.localDate(Self.lateEvening, calendar: calendar) == "2026-10-31")
        calendar.timeZone = try #require(TimeZone(identifier: "UTC"))
        #expect(ScanCheckoutModel.localDate(Self.lateEvening, calendar: calendar) == "2026-11-01")
    }
}

struct RunSummaryCardTests {
    @Test
    func `shows the haul's cost, the estimated resale and payout, and the estimated profit, labeled`() throws {
        let card = try RunSummaryCard(decodeRunSummary(runSummaryJSON()))
        #expect(card.title == "Goodwill Outlet")
        #expect(card.counts == "12 scanned · 3 kept · 8 miles")
        #expect(card.paid == "Paid $20.00 for 4 items · $5.00 each")
        #expect(card.resale == "$75-$112")
        #expect(card.payout == "You'd get about $62-$91 after fees")
        #expect(card.profit == "$42-$71")
        #expect(card.profitTone == .success)
        #expect(card.profitLabel == "Estimated, after fees")
        #expect(card.basedOn == "1 from your own sales, 2 from the AI estimate")
        #expect(card.estimateLabel == "Estimated - includes the AI estimate, not based on sold listings")
    }

    @Test
    func `has no cost or profit before checkout`() throws {
        let card = try RunSummaryCard(decodeRunSummary(runSummaryJSON(checkedOut: false)))
        #expect(card.paid == nil)
        #expect(card.profit == nil)
        #expect(card.resale == "$75-$112")
        #expect(card.counts == "12 scanned · 3 kept")
    }

    @Test
    func `says a range crossing zero as from a loss, and how many kept items the estimate covers`() throws {
        let card = try RunSummaryCard(decodeRunSummary(runSummaryJSON(
            place: nil,
            miles: 1,
            keptItems: 5,
            estimatedItems: 3,
            profit: (-500, 2000),
        )))
        #expect(card.title == "This run")
        #expect(card.counts == "12 scanned · 5 kept · 1 mile")
        #expect(card.profit == "-$5 to $20")
        #expect(card.profitTone == .actionNeeded)
        #expect(card.basedOn == "1 from your own sales, 2 from the AI estimate (3 of 5 kept items)")
        let loss = try RunSummaryCard(decodeRunSummary(runSummaryJSON(profit: (-2000, -500))))
        #expect(loss.profit == "-$20 to -$5")
        #expect(loss.profitTone == .failed)
    }

    @Test
    func `says when nothing kept had a range, with no estimate or profit`() throws {
        let card = try RunSummaryCard(decodeRunSummary(runSummaryJSON(estimatedItems: nil)))
        #expect(card.resale == nil)
        #expect(card.profit == nil)
        #expect(card.estimateLabel == nil)
        #expect(card.basedOn == "Nothing kept had a price range to go on")
        #expect(card.paid == "Paid $20.00 for 4 items · $5.00 each")
    }
}
