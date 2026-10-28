import APIClient
import Core
import Foundation
import Testing
@testable import SyncFeature

/// The sync's indicator and Sync now (docs/features/sync.md): what the phone is doing in plain
/// words, what a marketplace's reads found once they end, a failure with Try again, and one sync
/// on opening the app, never again on its own.
@MainActor
struct SyncModelTests {
    let service = FakeSyncService()
    let sleeps = ManualSleeps()
    let progress = FakeProgress()
    let trigger = FakeTrigger()

    func model(signedIn: Bool = true) -> SyncModel {
        let sleeps = sleeps
        let model = SyncModel(
            service: service,
            isSignedIn: { signedIn },
            lookEvery: .seconds(2),
            followFor: .seconds(10),
            resultFor: .seconds(6),
            sleep: { try await sleeps.sleep($0) },
        )
        model.progress = progress
        model.phoneWork = trigger
        return model
    }

    @Test
    func `sync now asks Listora, runs the phone, and follows each marketplace to what it found`() async {
        await service.answerRequest([.depop(.syncing, "Checking sales...")])
        let model = model()
        await model.syncNow()
        #expect(await service.requests == 1)
        #expect(trigger.reasons == [.userAction])
        #expect(model.lines == [line("depop", "Syncing Depop...", .working)])
        #expect(model.isSyncing)

        // The phone claimed the sale check, then the offer read.
        progress.progress = [.running("depop", "sale_check")]
        #expect(model.lines == [line("depop", "Checking Depop sales...", .working)])
        progress.progress = [.running("depop", "offer_check")]
        #expect(model.lines == [line("depop", "Checking Depop offers...", .working)])

        // The reads ended: Listora says what they found.
        progress.progress = []
        await service.answerStatus([.depop(.synced, "52 sales found, 1 offer waiting")])
        await sleeps.pass(.seconds(2))
        #expect(model.lines == [line("depop", "Depop: 52 sales found, 1 offer waiting", .found)])
        #expect(!model.isSyncing)
        // It goes after a few seconds.
        await sleeps.pass(.seconds(6))
        #expect(model.lines.isEmpty)
    }

    @Test
    func `a marketplace the phone still runs is not settled from Listora's answer`() async {
        await service.answerRequest([.depop(.syncing, "Checking sales...")])
        let model = model()
        await model.syncNow()
        progress.progress = [.running("depop", "listing_import")]
        await service.answerStatus([.depop(.synced, "No new sales")])
        await sleeps.pass(.seconds(2))
        #expect(model.lines == [line("depop", "Reading your Depop listings...", .working)])
        progress.progress = []
        await sleeps.pass(.seconds(2))
        #expect(model.lines == [line("depop", "Depop: No new sales", .found)])
    }

    @Test
    func `a failure stays with Try again, which syncs again`() async {
        await service.answerRequest([.poshmark(.syncing, "Checking sales...")])
        let model = model()
        await model.syncNow()
        await service.answerStatus([.poshmark(.failed, "Couldn't check sales. Sync again to try again.")])
        await sleeps.pass(.seconds(2))
        let failed = line("poshmark", "Poshmark: Couldn't check sales. Sync again to try again.", .failed)
        #expect(model.lines == [failed])
        await sleeps.pass(.seconds(6))
        #expect(model.lines == [failed])

        await service.answerRequest([.poshmark(.syncing, "Checking sales...")])
        await model.syncNow()
        #expect(await service.requests == 2)
        #expect(model.lines == [line("poshmark", "Syncing Poshmark...", .working)])
    }

    @Test
    func `an unreachable Listora says so in plain words`() async {
        await service.failRequests()
        let model = model()
        await model.syncNow()
        #expect(model.lines == [
            line("listora", "Listora couldn't be reached to sync. Check your connection and try again.", .failed),
        ])
        #expect(trigger.reasons.isEmpty)
        model.dismiss(model.lines[0])
        #expect(model.lines.isEmpty)
    }

    @Test
    func `a server from before Sync says so, without Try again`() async {
        await service.failRequests(statusCode: 404)
        let model = model()
        await model.syncNow()
        #expect(model.lines == [line(
            "listora", "Sync now isn't on Listora's server yet. Your sales are still checked as before.", .found,
        )])
        #expect(trigger.reasons.isEmpty)
        await sleeps.pass(.seconds(6))
        #expect(model.lines.isEmpty)
    }

    @Test
    func `a marketplace synced moments ago shows what that sync found`() async {
        await service.answerRequest([
            .depop(.synced, "No new sales"),
            .mercari(.syncing, "Checking sales..."),
        ])
        let model = model()
        await model.syncNow()
        #expect(model.lines == [
            line("depop", "Depop: No new sales", .found),
            line("mercari", "Syncing Mercari...", .working),
        ])
    }

    @Test
    func `nothing linked says what to do`() async {
        await service.answerRequest([])
        let model = model()
        await model.syncNow()
        #expect(model.lines == [line("listora", "Link a marketplace to sync it.", .found)])
    }

    @Test
    func `a listing change shows while it runs and leaves no result`() async {
        let model = model()
        progress.progress = [.running("depop", "operation")]
        #expect(model.lines == [line("depop", "Updating your Depop listing...", .working)])
        progress.progress = []
        #expect(model.lines.isEmpty)
        #expect(await service.requests == 0)
    }

    @Test
    func `opening the app syncs once, and never again until the next person`() async {
        await service.answerRequest([.depop(.synced, "No new sales")])
        let model = model()
        await model.syncOnOpen()
        await model.syncOnOpen()
        #expect(await service.requests == 1)
        model.signedOut()
        #expect(model.lines.isEmpty)
        await model.syncOnOpen()
        #expect(await service.requests == 2)
    }

    @Test
    func `signed out never syncs`() async {
        let model = model(signedIn: false)
        await model.syncOnOpen()
        await model.syncNow()
        #expect(await service.requests == 0)
        #expect(model.lines.isEmpty)
    }

    @Test
    func `stops following after a while`() async {
        await service.answerRequest([.depop(.syncing, "Checking sales...")])
        await service.answerStatus([.depop(.syncing, "Checking sales...")])
        let model = model()
        await model.syncNow()
        for _ in 0 ..< 5 {
            await sleeps.pass(.seconds(2))
        }
        #expect(model.lines.isEmpty)
        #expect(sleeps.pending.isEmpty)
    }

    @Test
    func `last synced is Listora's word`() async {
        let syncedAt = Date(timeIntervalSince1970: 1_793_190_000)
        await service.answerStatus([MarketplaceSyncStatus(
            marketplace: "depop", state: .synced, statusText: "No new sales", lastSyncedAt: syncedAt,
        )])
        let model = model()
        #expect(model.lastSyncedAt("depop") == nil)
        await model.refreshStatus()
        #expect(model.lastSyncedAt("depop") == syncedAt)
        #expect(model.lastSyncedAt("poshmark") == nil)
    }

    @Test
    func `names every kind of phone work`() {
        let words = [
            "sale_check", "sale_history", "offer_check", "offer_response", "listing_import",
            "session_check", "label_read", "operation", "something_new",
        ].map { SyncModel.doing($0, on: "depop") }
        #expect(words == [
            "Checking Depop sales...",
            "Reading your Depop sales history...",
            "Checking Depop offers...",
            "Answering a Depop offer...",
            "Reading your Depop listings...",
            "Checking your Depop sign-in...",
            "Reading a Depop shipping label...",
            "Updating your Depop listing...",
            "Working on Depop...",
        ])
        #expect(SyncModel.doing(nil, on: "ebay") == "Working on eBay...")
    }

    private func line(_ id: String, _ text: String, _ kind: SyncLineKind) -> SyncModel.Line {
        SyncModel.Line(id: id, text: text, kind: kind)
    }
}

extension MarketplaceSyncStatus {
    static func depop(_ state: State, _ text: String) -> Self {
        .init(marketplace: "depop", state: state, statusText: text)
    }

    static func poshmark(_ state: State, _ text: String) -> Self {
        .init(marketplace: "poshmark", state: state, statusText: text)
    }

    static func mercari(_ state: State, _ text: String) -> Self {
        .init(marketplace: "mercari", state: state, statusText: text)
    }
}

extension PhoneWorkProgress {
    static func running(_ marketplace: String, _ purpose: String) -> Self {
        .init(
            marketplace: marketplace, operationID: nil, purpose: purpose, step: nil, stepNumber: 0, stepCount: nil,
            expectedEnd: nil,
        )
    }
}

actor FakeSyncService: SyncService {
    private(set) var requests = 0
    private var requestReply: [MarketplaceSyncStatus] = []
    private var statusReply: [MarketplaceSyncStatus] = []
    private var unreachable = false
    private var failureStatus: Int?

    func answerRequest(_ reply: [MarketplaceSyncStatus]) {
        requestReply = reply
    }

    func answerStatus(_ reply: [MarketplaceSyncStatus]) {
        statusReply = reply
    }

    func failRequests(statusCode: Int? = nil) {
        unreachable = true
        failureStatus = statusCode
    }

    func status() async throws(APIFailure) -> [MarketplaceSyncStatus] {
        statusReply
    }

    func requestSync(idempotencyKey _: String) async throws(APIFailure) -> [MarketplaceSyncStatus] {
        requests += 1
        if unreachable {
            throw APIFailure(statusCode: failureStatus, code: "network", message: "Offline.", retryable: true)
        }
        return requestReply
    }
}

@MainActor
final class FakeProgress: PhoneWorkProgressSource {
    var progress: [PhoneWorkProgress] = []
}

@MainActor
final class FakeTrigger: PhoneWorkTrigger {
    private(set) var reasons: [PhoneWorkReason] = []

    func runPhoneWork(_ reason: PhoneWorkReason) {
        reasons.append(reason)
    }
}

/// The model's waits, ended by the test: `pass` ends every wait of that length, then lets the
/// model run what follows.
@MainActor
final class ManualSleeps {
    private var waiting: [(duration: Duration, continuation: CheckedContinuation<Void, any Error>)] = []

    var pending: [Duration] {
        waiting.map(\.duration)
    }

    func sleep(_ duration: Duration) async throws {
        try await withCheckedThrowingContinuation { waiting.append((duration, $0)) }
    }

    func pass(_ duration: Duration) async {
        await settle()
        let ending = waiting.filter { $0.duration == duration }
        waiting.removeAll { $0.duration == duration }
        ending.forEach { $0.continuation.resume() }
        await settle()
    }

    private func settle() async {
        for _ in 0 ..< 20 {
            await Task.yield()
        }
    }
}
