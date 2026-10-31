import APIClient
import Core
import DesignSystem
import Foundation
import ImageIO
import ListoraAPI
import Synchronization
import Testing
@testable import AddItemFeature

@MainActor
@Suite(.timeLimit(.minutes(1)))
struct ScanCardTests {
    @Test
    func `shows the call with its confidence and basis, own sales, and the labeled AI estimate`() throws {
        let card = try ScanCard(decodeScan(itemScanJSON()))
        #expect(card.title == "Lululemon black high-rise leggings")
        #expect(card.subtitle == "Size 6 · Pre-owned good")
        #expect(card.call == .buy)
        #expect(card.callLabel == "Buy")
        #expect(card.confidence == "Medium confidence")
        #expect(card.basedOn == "Your 3 sales like it")
        #expect(card.range == "$25-$29")
        #expect(card.payout == "You'd get about $22-$26 after Depop fees")
        #expect(card.ownSales.map(\.summary) == ["3 sold · $25-$29 · median $28"])
        #expect(card.aiEstimate == "$24-$40")
        #expect(card.aiEstimateLabel == "AI estimate - not based on sold listings")
        #expect(card.flags == ["Often faked: check it's real"])
        #expect(card.links.first?.label == "Search Depop")
        #expect(!card.wantsTag)
    }

    @Test
    func `is felt without looking: two taps for Buy, a long buzz for Skip, nothing for Your call`() throws {
        #expect(try ScanCard(decodeScan(itemScanJSON(call: "buy"))).haptic == .doubleTap)
        #expect(try ScanCard(decodeScan(itemScanJSON(call: "skip"))).haptic == .longBuzz)
        #expect(try ScanCard(decodeScan(itemScanJSON(call: "your_call"))).haptic == nil)
        // A call added after this build shows by its label and is felt as nothing.
        let later = try ScanCard(decodeScan(itemScanJSON(call: "maybe_later")))
        #expect(later.call == .other)
        #expect(later.haptic == nil)
    }

    @Test
    func `asks for the tag when the brand is missing or the read unsure`() throws {
        #expect(try ScanCard(decodeScan(itemScanJSON(brand: nil))).wantsTag)
        #expect(try ScanCard(decodeScan(itemScanJSON(identityConfidence: 0.4))).wantsTag)
    }

    @Test
    func `measures cards at the median and the slowest 5 percent, and active time per item`() {
        let measured = ScanMeasurements(cardTimes: [3.0, 1.0, 2.0, 1.5, 9.0], active: 12, items: 4)
        #expect(measured.cardMedian == 2.0)
        #expect(measured.cardP95 == 9.0)
        #expect(measured.activePerItem == 3)
        #expect(measured.line == "Card 2.0 s · 95% 9.0 s · active 3.0 s an item")
        #expect(ScanMeasurements(cardTimes: [], active: nil, items: 0).line == nil)
    }
}

@MainActor
@Suite(.timeLimit(.minutes(1)))
struct ScanRunModelTests {
    private struct Kept {
        var photos: [(PreparedPhoto, PhotoRole)]
        var scanID: String
    }

    private final class Saver {
        var kept: [Kept] = []
    }

    private func makeRun(
        _ service: FakeScanService,
        saver: Saver = Saver(),
        tagReader: any TagReader = FakeTagReader(),
        researchDwell: Duration = .zero,
    ) -> ScanRunModel {
        ScanRunModel(
            service: service,
            tagReader: tagReader,
            directory: FileManager.default.temporaryDirectory.appending(path: "scan-tests-\(UUID().uuidString)"),
            saveDraft: { photos, scanID in
                saver.kept.append(Kept(photos: photos, scanID: scanID))
                return "draft-\(saver.kept.count)"
            },
            researchDwell: researchDwell,
        )
    }

    private func capture(_ seed: UInt64 = 1) -> Data {
        TestImages.jpeg(width: 1600, height: 1200, seed: seed)
    }

    @Test
    func `reads a shot at once with the tag text, a small JPEG, and one run for every scan`() async throws {
        let service = FakeScanService()
        let run = makeRun(service)
        await run.shoot(capture())
        await run.shoot(capture(2))

        let scans = service.calls.scans
        #expect(service.calls.runs == 1)
        #expect(scans.count == 2)
        #expect(scans.allSatisfy { $0.runID == "run-1" && $0.tagJPEG == nil })
        #expect(scans.first?.tagText == ["ACME", "RN 12345"])
        // The read sends the 1024-pixel JPEG, not the upload-sized photo.
        let size = try #require(ImageSize(scans[0].itemJPEG))
        #expect(max(size.width, size.height) == ScanPhotos.scanLongEdge)
        #expect(run.entries.map(\.number) == [1, 2])
        #expect(run.entries.allSatisfy { $0.card != nil && $0.cardAfter != nil })
        #expect(run.cardTimes.count == 2)
    }

    @Test
    func `starts the server run as the camera opens, and the first shot reads in it`() async throws {
        let service = FakeScanService()
        let run = makeRun(service)
        run.prepare()
        run.prepare()
        #expect(try await eventually { service.calls.runs == 1 })
        await run.shoot(capture())
        #expect(service.calls.runs == 1)
        #expect(service.calls.scans.first?.runID == "run-1")
    }

    @Test
    func `times the card from the shutter press, not from when the photo was ready`() async throws {
        let service = FakeScanService()
        let run = makeRun(service)
        await run.shoot(capture(), shotAt: Date().addingTimeInterval(-5))
        let cardAfter = try #require(run.current?.cardAfter)
        #expect(cardAfter >= 5)
    }

    @Test
    func `the tag text deadline holds even when the reading does not stop at once`() async {
        let started = ContinuousClock.now
        let lines = await ScanTagText.read(
            capture(),
            with: StubbornTagReader(takes: .seconds(3)),
            within: .milliseconds(100),
        )
        #expect(lines.isEmpty)
        #expect(ContinuousClock.now - started < .seconds(1))
        // A reading inside the deadline is taken.
        let read = await ScanTagText.read(capture(), with: FakeTagReader(), within: .seconds(5))
        #expect(read == ["ACME", "RN 12345"])
    }

    @Test
    func `the scan does not wait past the deadline for a slow tag reading`() async {
        let service = FakeScanService()
        let run = makeRun(service, tagReader: StubbornTagReader(takes: .seconds(5)))
        let started = ContinuousClock.now
        await run.shoot(capture())
        #expect(ContinuousClock.now - started < .seconds(3))
        #expect(service.calls.scans.first?.tagText == [])
        #expect(run.current?.card != nil)
    }

    @Test
    func `looks up only a card the seller is still looking at, and a skipped one picked again`() async throws {
        let service = FakeScanService()
        let run = makeRun(service, researchDwell: .milliseconds(300))
        await run.shoot(capture())
        let skipped = try #require(run.current)
        // Shot the next item at once: the first is skipped before it was looked up.
        service.answer(scanJSON: itemScanJSON(id: "scan-2"))
        await run.shoot(capture(2))
        #expect(service.researched.isEmpty)
        // The card on screen is looked up once the dwell passes; the skipped one never was.
        #expect(try await eventually { service.researched == ["scan-2"] })
        try await Task.sleep(for: .milliseconds(400))
        #expect(service.researched == ["scan-2"])
        // Picked again in the tray, the skipped item is looked up at once, and only once.
        run.select(skipped.id)
        let skippedScanID = try #require(skipped.scanID)
        #expect(try await eventually { service.researched == ["scan-2", skippedScanID] })
        run.select(skipped.id)
        #expect(try await eventually { run.current?.research == .failed })
        run.select(skipped.id)
        #expect(service.researched.count == 2)
    }

    @Test
    func `asking for the tag before the dwell looks up only the read with the tag`() async throws {
        let service = FakeScanService()
        let run = makeRun(service, researchDwell: .milliseconds(300))
        await run.shoot(capture())
        let firstScanID = try #require(run.current?.scanID)
        run.startTagShot()
        service.answer(scanJSON: itemScanJSON(id: "scan-tag"))
        await run.shoot(capture(3))
        #expect(try await eventually { service.researched == ["scan-tag"] })
        #expect(!service.researched.contains(firstScanID))
    }

    @Test
    func `shooting the next item skips the last one, which the tray can still keep`() async throws {
        let service = FakeScanService()
        let saver = Saver()
        let run = makeRun(service, saver: saver)
        await run.shoot(capture())
        let first = try #require(run.current)
        await run.shoot(capture(2))
        #expect(run.currentID != first.id)
        #expect(run.entries.first?.decision == .open)

        run.select(first.id)
        await run.keep(first.id)
        #expect(run.entries.first?.decision == .kept(draftID: "draft-1"))
        #expect(run.keptCount == 1)
        let kept = try #require(saver.kept.first)
        #expect(kept.scanID == first.scanID)
        // The draft gets the upload-sized photo of the shot.
        #expect(kept.photos.map(\.1) == [.front])
        #expect(kept.photos.first.map { max($0.0.width, $0.0.height) } == 1600)
        // Kept once: a second tap does nothing.
        await run.keep(first.id)
        #expect(saver.kept.count == 1)
    }

    @Test
    func `a note before a shot rides along; one after the read reads the item again once`() async throws {
        let service = FakeScanService()
        let run = makeRun(service)
        await run.addNote("size medium")
        #expect(run.pendingNote == "size medium")
        await run.shoot(capture())
        #expect(service.calls.scans.first?.note == "size medium")
        #expect(run.pendingNote == nil)
        let firstScanID = try #require(run.current?.scanID)

        await run.addNote("small stain")
        let again = try #require(service.calls.scans.last)
        #expect(service.calls.scans.count == 2)
        #expect(again.note == "size medium. small stain")
        #expect(again.replacesScanID == firstScanID)
    }

    @Test
    func `a note said while the read runs reads it again once the first read lands`() async throws {
        let service = FakeScanService()
        let run = makeRun(service)
        await service.gate.close()
        let shot = Task { await run.shoot(capture()) }
        #expect(try await eventually { run.current?.state == .reading })
        await run.addNote("no flaws")
        await service.gate.open()
        await shot.value
        #expect(service.calls.scans.count == 2)
        #expect(service.calls.scans.last?.note == "no flaws")
        #expect(service.calls.scans.last?.replacesScanID != nil)
    }

    @Test
    func `the tag close-up reads the item again with both images, and the draft keeps both`() async throws {
        let service = FakeScanService()
        let saver = Saver()
        let run = makeRun(service, saver: saver)
        await run.shoot(capture())
        run.startTagShot()
        #expect(run.tagShotFor == run.currentID)
        await run.shoot(capture(3))
        #expect(run.entries.count == 1)
        let reread = try #require(service.calls.scans.last)
        #expect(reread.tagJPEG != nil)
        #expect(reread.replacesScanID != nil)
        try await run.keep(#require(run.currentID))
        #expect(saver.kept.first?.photos.map(\.1) == [.front, .tag])
    }

    @Test
    func `a failed read shows its message with Retry, and Retry reads it again`() async throws {
        let service = FakeScanService()
        let run = makeRun(service)
        service.answer(failure: APIFailure(
            statusCode: 503,
            code: "service_unavailable",
            message: "Couldn't read this one. Try again.",
            retryable: true,
        ))
        await run.shoot(capture())
        #expect(run.current?.state == .failed(message: "Couldn't read this one. Try again.", retryable: true))
        try await run.keep(#require(run.currentID))
        #expect(run.current?.decision == .open)

        try await run.retry(#require(run.currentID))
        #expect(run.current?.card?.call == .buy)
    }

    @Test
    func `looks the item up on the web after the read, and the card takes in what it found`() async throws {
        let service = FakeScanService()
        let run = makeRun(service)
        await run.shoot(capture())
        let entry = try #require(run.current)
        let scanID = try #require(entry.scanID)
        #expect(entry.card != nil)
        // The research was asked for without holding the card up; this one fails quietly.
        #expect(try await eventually { run.current?.research == .failed })
        #expect(service.researched == [scanID])
        #expect(run.current?.card?.call == .buy)

        try service.answerResearch(JSONSerialization.data(withJSONObject: researchedScanJSON(id: "scan-2")))
        // The default answer reuses its id; a second shot gets the scripted research.
        service.answer(scanJSON: itemScanJSON(id: "scan-2"))
        await run.shoot(capture(2))
        #expect(try await eventually { run.current?.research == .done })
        let card = try #require(run.current?.card)
        #expect(card.signals.first?.label == "Retail $60-$98 across 3 models")
        #expect(card.web?.models == "Models: 501, 517, 527")
        #expect(card.web?.resale == "Asks $30-$50 on poshmark.com, ebay.com")
        #expect(card.web?.label == "Web info - not sold listings")
    }

    @Test
    func `asks the web nothing for a read without a brand`() async {
        let service = FakeScanService()
        let run = makeRun(service)
        service.answer(scanJSON: itemScanJSON(brand: nil))
        await run.shoot(capture())
        #expect(run.current?.research == ScanEntry.Research.none)
        #expect(service.researched.isEmpty)
    }

    @Test
    func `ending the run ends it on the server and takes no more shots`() async {
        let service = FakeScanService()
        let run = makeRun(service)
        await run.shoot(capture())
        await run.end()
        #expect(service.calls.ended == ["run-1"])
        #expect(run.isEnded)
        await run.shoot(capture(2))
        #expect(run.entries.count == 1)
    }
}

/// A JPEG's pixel size.
private struct ImageSize {
    let width: Int
    let height: Int

    init?(_ data: Data) {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int
        else { return nil }
        self.width = width
        self.height = height
    }
}
