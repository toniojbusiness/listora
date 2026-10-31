import Core
import Foundation
import Testing
@testable import AddItemFeature

/// The scan's speed and lookup cost (docs/features/thrift-scan.md, "Speed"): the run made as
/// the camera opens, the card timed from the shutter, the tag text's deadline, and web research
/// only for a card the seller is still looking at.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct ScanSpeedTests {
    private func makeRun(
        _ service: FakeScanService,
        tagReader: any TagReader = FakeTagReader(),
        researchDwell: Duration = .zero,
    ) -> ScanRunModel {
        ScanRunModel(
            service: service,
            tagReader: tagReader,
            directory: FileManager.default.temporaryDirectory.appending(path: "scan-speed-\(UUID().uuidString)"),
            saveDraft: { _, _ in nil },
            researchDwell: researchDwell,
        )
    }

    private func capture(_ seed: UInt64 = 1) -> Data {
        TestImages.jpeg(width: 1600, height: 1200, seed: seed)
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
}
