import Core
import Foundation
import Testing
@testable import MarketplaceLinkingFeature

/// "Last synced" on Link accounts (docs/features/sync.md): when a read of each marketplace last got
/// through, as the sync says, read again each time the screen loads.
@MainActor
struct LastSyncedTests {
    @Test
    func `says when each marketplace last synced, and nothing before its first sync`() async throws {
        let now = Date(timeIntervalSince1970: 1_793_190_000)
        let sync = FakeSync(lastSynced: ["depop": now.addingTimeInterval(-5 * 60)])
        let model = LinkAccountsModel(
            service: FakeSessionService(list: [.depop(.linked)], link: .depop(.linked), polls: []),
            makeIdempotencyKey: { UUID().uuidString },
            pollInterval: .zero,
            maxPolls: 1,
            sleep: { _ in },
            now: { now },
        )
        model.sync = sync
        await model.load()
        let depop = try #require(model.links.first)
        #expect(model.lastSynced(depop) == "Last synced 5 minutes ago")
        sync.lastSynced["depop"] = now.addingTimeInterval(-10)
        #expect(model.lastSynced(depop) == "Last synced just now")
        sync.lastSynced = [:]
        #expect(model.lastSynced(depop) == nil)
        // Loading the screen reads each marketplace's sync again.
        for _ in 0 ..< 10 {
            await Task.yield()
        }
        #expect(sync.refreshes >= 1)
    }
}

@MainActor
private final class FakeSync: MarketplaceSync {
    var lastSynced: [String: Date]
    private(set) var refreshes = 0
    let isSyncing = false

    init(lastSynced: [String: Date]) {
        self.lastSynced = lastSynced
    }

    func syncNow() async {}

    func refreshStatus() async {
        refreshes += 1
    }

    func lastSyncedAt(_ marketplace: String) -> Date? {
        lastSynced[marketplace]
    }
}
