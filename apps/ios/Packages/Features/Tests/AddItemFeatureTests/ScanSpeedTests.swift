import Core
import Foundation
import Testing
@testable import AddItemFeature

/// The scan's speed (docs/features/thrift-scan.md, "Speed"): the run made as the camera opens,
/// the card timed from the shutter, the tag text's deadline, and every read's prices asked for
/// at once, since the server looks each one up as its read lands.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct ScanSpeedTests {
    private func makeRun(
        _ service: FakeScanService,
        tagReader: any TagReader = FakeTagReader(),
    ) -> ScanRunModel {
        ScanRunModel(
            service: service,
            tagReader: tagReader,
            directory: FileManager.default.temporaryDirectory.appending(path: "scan-speed-\(UUID().uuidString)"),
            saveDraft: { _, _ in nil },
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
    func `asks for every read's prices at once, a skipped one too, and once each`() async throws {
        let service = FakeScanService()
        let run = makeRun(service)
        await run.shoot(capture())
        let skipped = try #require(run.current)
        // Shot the next item at once: the first one's prices were asked for all the same, since
        // the server looks it up as the read lands.
        service.answer(scanJSON: itemScanJSON(id: "scan-2"))
        await run.shoot(capture(2))
        let skippedScanID = try #require(skipped.scanID)
        #expect(try await eventually { Set(service.researched) == [skippedScanID, "scan-2"] })
        #expect(try await eventually { run.entries.allSatisfy { $0.research == .failed } })
        // Picked again in the tray, nothing is asked twice.
        run.select(skipped.id)
        try await Task.sleep(for: .milliseconds(100))
        #expect(service.researched.count == 2)
    }

    @Test
    func `a read with the tag asks for its own prices, and the one it replaced never lands`() async throws {
        let service = FakeScanService()
        let run = makeRun(service)
        await run.shoot(capture())
        let firstScanID = try #require(run.current?.scanID)
        run.startTagShot()
        service.answer(scanJSON: itemScanJSON(id: "scan-tag"))
        await run.shoot(capture(3))
        #expect(try await eventually { service.researched.contains("scan-tag") })
        #expect(run.current?.scanID == "scan-tag")
        #expect(service.researched.filter { $0 == firstScanID }.count <= 1)
    }
}
