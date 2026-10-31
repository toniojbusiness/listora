import APIClient
import Core
import Foundation
import Synchronization
import Testing
@testable import AddItemFeature

// Invented brands and sales; no real shop's data.

/// Online or not, as a test says; every change goes to the listeners.
final class FakeConnectivity: ScanConnectivity {
    private let state = Mutex<(online: Bool, listeners: [AsyncStream<Bool>.Continuation])>((true, []))

    init(online: Bool) {
        state.withLock { $0.online = online }
    }

    var isOnline: Bool {
        state.withLock { $0.online }
    }

    func set(online: Bool) {
        let listeners = state.withLock { state in
            state.online = online
            return state.listeners
        }
        for listener in listeners {
            listener.yield(online)
        }
    }

    func changes() -> AsyncStream<Bool> {
        let (stream, continuation) = AsyncStream<Bool>.makeStream()
        let online = state.withLock { state in
            state.listeners.append(continuation)
            return state.online
        }
        continuation.yield(online)
        return stream
    }
}

/// Feature prints by the image's first byte past the JPEG header: the same image, the same print.
final class FakeSignalReader: PhotoSignalReader {
    func signals(of imageData: Data) async throws -> ShotSignals {
        let print = imageData.prefix(4096).reduce(into: [Float](repeating: 0, count: 8)) { print, byte in
            print[Int(byte) % 8] += 1
        }
        let length = print.reduce(0) { $0 + $1 * $1 }.squareRoot()
        return ShotSignals(featurePrint: print.map { $0 / max(length, 1) }, tagLikelihood: 0)
    }
}

/// The kit of the tests: ACME (the fake tag reader's brand) sold well, Thrift Co. too little.
func testKit() -> SourcingKit {
    let usd = { (cents: Int) in SourcingKit.Money(amountCents: cents) }
    return SourcingKit(
        version: SourcingKit.supportedVersion,
        generatedAt: "2026-10-31T12:00:00.000Z",
        call: .init(worthListing: usd(800), minComparisons: 3),
        buckets: [
            .init(
                brand: "Acme",
                brandKey: "acme",
                unsoldCount: 2,
                forCall: .init(
                    soldCount: 5,
                    low: usd(2500),
                    high: usd(3400),
                    payoutMarketplace: "depop",
                    conservativePayout: usd(2210),
                    optimisticPayout: usd(3010),
                ),
            ),
        ],
    )
}

@MainActor
@Suite(.timeLimit(.minutes(1)))
struct ScanOfflineTests {
    private final class Saver {
        var kept: [String?] = []
    }

    private struct Run {
        let model: ScanRunModel
        let service: FakeScanService
        let connectivity: FakeConnectivity
        let saver: Saver
    }

    private func dependencies(
        _ service: FakeScanService,
        _ connectivity: FakeConnectivity,
        _ saver: Saver,
        queue: ScanQueueStore? = nil,
    ) -> ScanRunDependencies {
        ScanRunDependencies(
            service: service,
            tagReader: FakeTagReader(),
            signalReader: FakeSignalReader(),
            connectivity: connectivity,
            queue: queue,
            kit: { testKit() },
            saveDraft: { _, scanID in
                saver.kept.append(scanID)
                return "draft-\(saver.kept.count)"
            },
        )
    }

    private func makeRun(online: Bool = false, queue: ScanQueueStore? = nil, directory: URL? = nil) -> Run {
        let service = FakeScanService()
        let connectivity = FakeConnectivity(online: online)
        let saver = Saver()
        let model = ScanRunModel(
            dependencies: dependencies(service, connectivity, saver, queue: queue),
            directory: directory ?? FileManager.default.temporaryDirectory.appending(path: "scan-\(UUID().uuidString)"),
        )
        return Run(model: model, service: service, connectivity: connectivity, saver: saver)
    }

    private func capture(_ seed: UInt64 = 1) -> Data {
        TestImages.jpeg(width: 1600, height: 1200, seed: seed)
    }

    @Test
    func `with no signal a shot gets the instant read from the household's sales, and its read waits`() async throws {
        let run = makeRun()
        await run.model.shoot(capture())
        let entry = try #require(run.model.current)
        #expect(entry.state == .waiting)
        #expect(run.service.calls.scans.isEmpty)
        #expect(run.service.calls.runs == 0)
        let instant = try OfflineScanCard(#require(entry.instant))
        #expect(instant.callLabel == "Buy")
        #expect(instant.confidence == "Medium confidence")
        #expect(instant.label == "From your sales only")
        #expect(instant.basedOn == "Your 5 Acme sales")
        #expect(instant.range == "$25-$34")
        #expect(instant.payout == "You'd get about $22-$30 after Depop fees")
        #expect(instant.unsold == "You have 2 Acme unsold")
        #expect(instant.haptic == .doubleTap)
        #expect(run.model.waitingCount == 1)
    }

    @Test
    func `once there is signal the waiting reads run newest first, each card saying it was read late`() async {
        let run = makeRun()
        await run.model.shoot(capture())
        await run.model.shoot(capture(2))
        #expect(run.model.waitingCount == 2)
        let shots = run.model.entries.map(\.itemJPEG)

        run.connectivity.set(online: true)
        await run.model.drain()
        #expect(run.service.calls.runs == 1)
        #expect(run.service.calls.scans.map(\.itemJPEG) == shots.reversed())
        #expect(run.model.entries.allSatisfy { $0.card != nil && $0.readLate })
        // A late card never counts toward the seconds from the shutter.
        #expect(run.model.cardTimes.isEmpty)
    }

    @Test
    func `a read cut off by the network waits, and is tried again under the same key`() async {
        let run = makeRun(online: true)
        run.service.answer(failure: .networkUnavailable)
        await run.model.shoot(capture())
        #expect(run.model.current?.state == .waiting)

        await run.model.drain()
        let keys = run.service.calls.scanKeys
        #expect(keys.count == 2)
        #expect(keys[0] == keys[1])
        #expect(run.model.current?.card?.call == .buy)
    }

    @Test
    func `a scan kept with no signal is saved as a draft once it is read`() async throws {
        let run = makeRun()
        await run.model.shoot(capture())
        let entryID = try #require(run.model.currentID)
        await run.model.keep(entryID)
        #expect(run.model.current?.decision == .keepWhenRead)
        #expect(run.saver.kept.isEmpty)

        run.connectivity.set(online: true)
        await run.model.drain()
        let scanID = try #require(run.model.current?.scanID)
        #expect(run.saver.kept == [scanID])
        #expect(run.model.current?.decision == .kept(draftID: "draft-1"))
    }

    @Test
    func `a run ended with kept scans waiting finishes once they are read and saved`() async throws {
        let run = makeRun()
        await run.model.shoot(capture())
        try await run.model.keep(#require(run.model.currentID))
        await run.model.shoot(capture(2))
        var finished = false
        run.model.onFinished = { _ in finished = true }

        await run.model.end()
        // The skipped one goes; the kept one waits for signal.
        #expect(run.model.entries.count == 1)
        #expect(!run.model.isFinished)
        #expect(run.service.calls.ended.isEmpty)

        run.connectivity.set(online: true)
        await run.model.drain()
        #expect(run.service.calls.scans.count == 1)
        #expect(run.saver.kept.count == 1)
        #expect(run.model.isFinished)
        #expect(finished)
        #expect(run.service.calls.ended == ["run-1"])
    }

    @Test
    func `a kept scan that can never be read is saved as an ordinary draft, never lost`() async throws {
        let run = makeRun()
        await run.model.shoot(capture())
        try await run.model.keep(#require(run.model.currentID))
        run.service.answer(failure: APIFailure(
            statusCode: 422,
            code: "validation_failed",
            message: "The image isn't a JPEG.",
            retryable: false,
        ))

        run.connectivity.set(online: true)
        await run.model.drain()
        #expect(run.saver.kept == [nil])
        #expect(run.model.current?.decision == .kept(draftID: "draft-1"))
    }

    @Test
    func `a note said with no signal rides along with the read due, under a new key`() async throws {
        let run = makeRun()
        await run.model.shoot(capture())
        let key = try #require(run.model.current?.readKey)
        await run.model.addNote("small stain")
        #expect(run.model.current?.note == "small stain")
        #expect(run.model.current?.readKey != key)
        #expect(run.service.calls.scans.isEmpty)

        run.connectivity.set(online: true)
        await run.model.drain()
        #expect(run.service.calls.scans.map(\.note) == ["small stain"])
    }

    @Test
    func `warns when a shot looks like an item already scanned in the run`() async throws {
        let run = makeRun()
        await run.model.shoot(capture(7))
        await run.model.shoot(capture(7))
        #expect(try await eventually { run.model.entries.last?.duplicateOf == 1 })
        #expect(run.model.entries.first?.duplicateOf == nil)
    }

    @Test
    func `keeps the run and its waiting scans across a relaunch, and reads them after`() async throws {
        let directory = try TemporaryDirectory()
        let database = try DraftDatabase(directory: directory.url)
        let queue = ScanQueueStore(writer: database.writer)
        let scans = directory.url.appending(path: "ScanRuns")
        let run = makeRun(queue: queue, directory: scans)
        await run.model.shoot(capture())
        try await run.model.keep(#require(run.model.currentID))
        await run.model.shoot(capture(2))
        await run.model.addNote("wool")
        #expect(try await eventually { try queue.runs().first?.entries.allSatisfy { $0.photo != nil } == true })

        // The app closes; a new launch finds the run as it was.
        let connectivity = FakeConnectivity(online: false)
        let service = FakeScanService()
        let saver = Saver()
        let runs = ScanRuns(
            dependencies: dependencies(service, connectivity, saver, queue: queue),
            directory: scans,
            kit: SourcingKitCache(file: nil),
        )
        let restored = try #require(runs.current)
        #expect(restored.id == run.model.id)
        #expect(restored.entries.map(\.number) == [1, 2])
        #expect(restored.entries.map(\.itemJPEG) == run.model.entries.map(\.itemJPEG))
        #expect(restored.entries.map(\.decision) == [.keepWhenRead, .open])
        #expect(restored.entries.last?.note == "wool")
        let allWaiting = restored.entries.allSatisfy(\.isWaiting)
        #expect(allWaiting)

        connectivity.set(online: true)
        await runs.refresh()
        #expect(service.calls.scans.count == 2)
        #expect(saver.kept.count == 1)
        #expect(restored.entries.allSatisfy { $0.card != nil })
        let kept = try queue.runs().first?.entries.first
        #expect(kept?.decision == .kept)
        #expect(kept?.scan != nil)
    }

    @Test
    func `a run ended while kept scans waited finishes after a relaunch, and leaves nothing behind`() async throws {
        let directory = try TemporaryDirectory()
        let database = try DraftDatabase(directory: directory.url)
        let queue = ScanQueueStore(writer: database.writer)
        let scans = directory.url.appending(path: "ScanRuns")
        let run = makeRun(queue: queue, directory: scans)
        await run.model.shoot(capture())
        try await run.model.keep(#require(run.model.currentID))
        #expect(try await eventually { try queue.runs().first?.entries.first?.photo != nil })
        await run.model.end()
        // A folder no kept run names is left over: the next launch removes it.
        let stray = scans.appending(path: "left-over")
        try FileManager.default.createDirectory(at: stray, withIntermediateDirectories: true)

        let connectivity = FakeConnectivity(online: true)
        let service = FakeScanService()
        let saver = Saver()
        let runs = ScanRuns(
            dependencies: dependencies(service, connectivity, saver, queue: queue),
            directory: scans,
            kit: SourcingKitCache(file: nil),
        )
        #expect(runs.current == nil)
        #expect(runs.finishing.count == 1)
        #expect(!FileManager.default.fileExists(atPath: stray.path()))

        await runs.refresh()
        #expect(saver.kept.count == 1)
        #expect(runs.finishing.isEmpty)
        #expect(try queue.runs().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: scans.appending(path: run.model.id).path()))
    }
}

@MainActor
@Suite(.timeLimit(.minutes(1)))
struct SourcingKitCacheTests {
    @Test
    func `keeps the fetched kit in its file for the next launch, and reads no unknown format`() async throws {
        let directory = try TemporaryDirectory()
        let file = directory.url.appending(path: "sourcing-kit.json")
        let service = FakeScanService()
        service.answer(kit: testKit())
        let cache = SourcingKitCache(file: file)
        #expect(cache.kit == nil)
        await cache.refresh(from: service)
        #expect(cache.kit == testKit())
        // Fetched lately: not again.
        await cache.refresh(from: service)
        #expect(service.calls.kits == 1)
        #expect(SourcingKitCache(file: file).kit == testKit())

        let kit = testKit()
        let later = SourcingKit(version: 3, generatedAt: kit.generatedAt, call: kit.call, buckets: kit.buckets)
        service.answer(kit: later)
        var now = Date()
        let fresh = SourcingKitCache(file: file, now: { now })
        now += SourcingKitCache.refreshInterval + 1
        await fresh.refresh(from: service)
        #expect(fresh.kit == testKit())
    }

    @Test
    func `keeps the kit it has when fetching fails`() async throws {
        let directory = try TemporaryDirectory()
        let file = directory.url.appending(path: "sourcing-kit.json")
        try JSONEncoder().encode(testKit()).write(to: file)
        let cache = SourcingKitCache(file: file)
        await cache.refresh(from: FakeScanService())
        #expect(cache.kit == testKit())
    }
}
