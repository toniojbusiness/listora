import Core
import Foundation
import Testing
@testable import AddItemFeature

/// Keep and Put back on the scan card (docs/features/thrift-scan.md, "On the iPhone"): either one
/// closes the card at once, back to the live camera for the next shot, with a brief line saying
/// what happened and how many items the run kept; shooting the next item puts the last one back.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct ScanDecisionTests {
    private final class Clock {
        var now = Date(timeIntervalSince1970: 1_800_000_000)
    }

    /// The drafts saved, and what the line over the camera said while each one was saved.
    private final class Saver {
        var saved = 0
        var fails = false
        var linesWhileSaving: [ScanConfirmationLine?] = []
        weak var run: ScanRunModel?
    }

    private func makeRun(_ service: FakeScanService, saver: Saver = Saver(), clock: Clock = Clock()) -> ScanRunModel {
        let run = ScanRunModel(
            service: service,
            tagReader: FakeTagReader(),
            directory: FileManager.default.temporaryDirectory.appending(path: "scan-decisions-\(UUID().uuidString)"),
            saveDraft: { _, _ in
                saver.linesWhileSaving.append(saver.run?.confirmationLine)
                guard !saver.fails else { return nil }
                saver.saved += 1
                return "draft-\(saver.saved)"
            },
            now: { clock.now },
        )
        saver.run = run
        return run
    }

    private func capture(_ seed: UInt64 = 1) -> Data {
        TestImages.jpeg(width: 1600, height: 1200, seed: seed)
    }

    @Test
    func `keep closes the card at once and says Kept with the run's count once the draft is saved`() async throws {
        let service = FakeScanService()
        let saver = Saver()
        let clock = Clock()
        let run = makeRun(service, saver: saver, clock: clock)
        await run.shoot(capture())
        let first = try #require(run.current)

        await run.keepAndContinue(first.id)
        // The camera was clear while the draft was still being saved, and the line said so.
        #expect(run.current == nil)
        #expect(saver.linesWhileSaving.first??.text == "Keeping item 1")
        #expect(saver.linesWhileSaving.first??.tone == .working)
        #expect(run.entries.first?.isKept == true)
        #expect(run.confirmationLine?.text == "Kept · 1 in this run")
        #expect(run.confirmationLine?.tone == .done)

        // The card left the screen 0.2 s after Keep: measured for the owner.
        clock.now += 0.2
        run.cardClosed(first.id)
        #expect(run.readyTimes == [0.2])
        // Only once.
        run.cardClosed(first.id)
        #expect(run.readyTimes.count == 1)

        await run.shoot(capture(2))
        try await run.keepAndContinue(#require(run.currentID))
        #expect(run.confirmationLine?.text == "Kept · 2 in this run")
        #expect(saver.saved == 2)
    }

    @Test
    func `put back closes the card, and the tray can still keep the item until the run ends`() async throws {
        let service = FakeScanService()
        let saver = Saver()
        let run = makeRun(service, saver: saver)
        await run.shoot(capture())
        let first = try #require(run.current)

        run.putBack(first.id)
        #expect(run.current == nil)
        #expect(run.entries.first?.decision == .open)
        #expect(run.confirmationLine?.text == "Put back · none kept yet")
        #expect(saver.saved == 0)

        // Put back is the same as shooting the next item: the tray keeps it.
        run.select(first.id)
        await run.keepAndContinue(first.id)
        #expect(run.keptCount == 1)
        await run.shoot(capture(2))
        try run.putBack(#require(run.currentID))
        #expect(run.confirmationLine?.text == "Put back · 1 kept this run")
    }

    @Test
    func `shooting the next item without choosing puts the last one back, with no line`() async throws {
        let service = FakeScanService()
        let run = makeRun(service)
        await run.shoot(capture())
        let first = try #require(run.current)
        await run.shoot(capture(2))
        #expect(run.currentID != first.id)
        #expect(run.entries.first?.decision == .open)
        #expect(run.confirmation == nil)
    }

    @Test
    func `a Keep that fails says so, and Keep from the tray tries again`() async throws {
        let service = FakeScanService()
        let saver = Saver()
        saver.fails = true
        let run = makeRun(service, saver: saver)
        await run.shoot(capture())
        let first = try #require(run.current)

        await run.keepAndContinue(first.id)
        #expect(run.current == nil)
        #expect(run.confirmationLine?.tone == .failed)
        #expect(run.confirmationLine?.text == "Couldn't keep item 1. Tap it below to try again.")
        #expect(run.keptCount == 0)

        saver.fails = false
        run.select(first.id)
        await run.keepAndContinue(first.id)
        #expect(run.entries.first?.isKept == true)
        #expect(run.confirmationLine?.text == "Kept · 1 in this run")
    }

    @Test
    func `put back works while the item is still reading, and its card does not come back`() async throws {
        let service = FakeScanService()
        let run = makeRun(service)
        await service.gate.close()
        let shot = Task { await run.shoot(capture()) }
        #expect(try await eventually { run.current?.state == .reading })
        let entryID = try #require(run.currentID)
        // Keep needs the read; Put back does not.
        #expect(run.current?.canKeep == false)
        run.putBack(entryID)
        #expect(run.current == nil)
        await service.gate.open()
        await shot.value
        #expect(run.current == nil)
        #expect(run.entries.first?.card != nil)
    }

    @Test
    func `a kept card opened from the tray closes back to the camera`() async throws {
        let service = FakeScanService()
        let run = makeRun(service)
        await run.shoot(capture())
        let first = try #require(run.current)
        await run.keepAndContinue(first.id)
        run.select(first.id)
        #expect(run.currentID == first.id)
        run.closeCard(first.id)
        #expect(run.current == nil)
        // Keeping it again does nothing.
        await run.keepAndContinue(first.id)
        #expect(run.keptCount == 1)
    }

    @Test
    func `a line goes only when it is still the newest one`() async throws {
        let service = FakeScanService()
        let run = makeRun(service)
        await run.shoot(capture())
        try run.putBack(#require(run.currentID))
        let old = try #require(run.confirmation)
        await run.shoot(capture(2))
        try run.putBack(#require(run.currentID))
        run.clearConfirmation(old.id)
        #expect(run.confirmation != nil)
        try run.clearConfirmation(#require(run.confirmation).id)
        #expect(run.confirmation == nil)
    }

    @Test
    func `the owner's measurements add how soon the camera is clear for the next shot`() {
        let measured = ScanMeasurements(cardTimes: [2.0], active: 3, items: 1, readyTimes: [0.4, 0.2, 0.3])
        #expect(measured.readyMedian == 0.3)
        #expect(measured.line == "Card 2.0 s · 95% 2.0 s · active 3.0 s an item · next shot 0.3 s")
    }
}
