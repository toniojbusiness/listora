import Core
import Foundation
import Testing
@testable import AddItemFeature

// Invented brands and sales; no real shop's data.

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
