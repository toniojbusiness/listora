import APIClient
import Core
import Foundation
import Observation

/// The sync of the linked marketplaces (docs/features/sync.md): Sync now, a pull to refresh, and
/// opening the app ask Listora for read-only checks of every marketplace (sales, offers, and
/// listings once imported), and the phone runs its share at once. Never on a timer.
///
/// The indicator (`lines`) says, per marketplace and in plain words, what the phone is doing
/// ("Checking Depop sales...", from the run's purpose), or what a sync Listora runs elsewhere is
/// doing, and once a marketplace's reads end, what they found ("Depop: 52 sales found") for a
/// few seconds, or why they didn't get through, with Try again, until the next sync. A listing
/// change the phone runs shows while it runs and leaves no result here: its own screen shows
/// whether it was done, from the marketplace's read-back.
/// What a line of the sync indicator says.
public enum SyncLineKind: Equatable, Sendable {
    /// Running now.
    case working
    /// What the reads found.
    case found
    /// The reads (or asking Listora for them) didn't get through; Try again syncs.
    case failed
}

@MainActor
@Observable
public final class SyncModel: MarketplaceSync {
    /// One line of the indicator.
    public struct Line: Equatable, Identifiable, Sendable {
        /// The marketplace id, or `listora` for Listora itself (it couldn't be reached).
        public let id: String
        public let text: String
        public let kind: SyncLineKind
    }

    /// Each linked marketplace's sync, as Listora last said.
    public private(set) var statuses: [MarketplaceSyncStatus] = []
    /// Whether the request for a sync is under way.
    public private(set) var requesting = false
    /// The phone's work running now, which the indicator names.
    public weak var progress: (any PhoneWorkProgressSource)?
    /// Runs the reads Listora hands this phone at once.
    public weak var phoneWork: (any PhoneWorkTrigger)?

    /// The marketplaces whose sync this app follows until their reads end.
    private var following: Set<String> = []
    /// What ended reads found, or why they failed, shown until `resultSeconds` passed (found) or
    /// the next sync (failed).
    private var results: [String: Line] = [:]
    private var follower: Task<Void, Never>?
    private var syncedOnOpen = false

    private let service: any SyncService
    private let isSignedIn: @MainActor () -> Bool
    private let sleep: @Sendable (Duration) async throws -> Void
    /// How often Listora is asked how the reads go while the app follows a sync (it reads only
    /// Listora's own records, never a marketplace).
    let lookEvery: Duration
    /// How long the app follows a sync before it stops looking.
    let followFor: Duration
    /// How long a result stays.
    let resultFor: Duration

    public init(
        service: any SyncService,
        isSignedIn: @escaping @MainActor () -> Bool,
        lookEvery: Duration = .seconds(2),
        followFor: Duration = .seconds(180),
        resultFor: Duration = .seconds(6),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
    ) {
        self.service = service
        self.isSignedIn = isSignedIn
        self.lookEvery = lookEvery
        self.followFor = followFor
        self.resultFor = resultFor
        self.sleep = sleep
    }

    /// What the indicator shows, in marketplace order (Listora's own problem first).
    public var lines: [Line] {
        var byMarketplace = results
        for status in statuses where following.contains(status.marketplace) && status.state == .syncing {
            byMarketplace[status.marketplace] = Line(
                id: status.marketplace,
                text: "Syncing \(Self.name(status.marketplace))...",
                kind: .working,
            )
        }
        for running in progress?.progress ?? [] {
            byMarketplace[running.marketplace] = Line(
                id: running.marketplace,
                text: Self.doing(running.purpose, on: running.marketplace),
                kind: .working,
            )
        }
        return byMarketplace.values.sorted { lhs, rhs in
            (lhs.id == Self.listora ? "" : lhs.id) < (rhs.id == Self.listora ? "" : rhs.id)
        }
    }

    public var isSyncing: Bool {
        requesting || lines.contains { $0.kind == .working }
    }

    /// The first time the app opens signed in: one sync, never again until the next launch.
    public func syncOnOpen() async {
        guard !syncedOnOpen, isSignedIn() else { return }
        syncedOnOpen = true
        await syncNow()
    }

    /// Signed out: the next person's first open syncs again, and nothing of this one's shows.
    public func signedOut() {
        syncedOnOpen = false
        statuses = []
        following = []
        results = [:]
    }

    public func syncNow() async {
        guard isSignedIn(), !requesting else { return }
        requesting = true
        defer { requesting = false }
        results = [:]
        let answered: [MarketplaceSyncStatus]
        do {
            answered = try await service.requestSync(idempotencyKey: UUID().uuidString)
        } catch {
            results[Self.listora] = Line(
                id: Self.listora,
                text: "Listora couldn't be reached to sync. Check your connection and try again.",
                kind: .failed,
            )
            return
        }
        statuses = answered
        if answered.isEmpty {
            show(Line(id: Self.listora, text: "Link a marketplace to sync it.", kind: .found))
        }
        for status in answered {
            if status.state == .syncing {
                following.insert(status.marketplace)
            } else {
                // Synced moments ago: what that sync found.
                finished(status)
            }
        }
        phoneWork?.runPhoneWork(.userAction)
        follow()
    }

    public func refreshStatus() async {
        guard isSignedIn(), let answered = try? await service.status() else { return }
        statuses = answered
    }

    public func lastSyncedAt(_ marketplace: String) -> Date? {
        statuses.first { $0.marketplace == marketplace }?.lastSyncedAt
    }

    /// Clears a result (the indicator's dismiss).
    public func dismiss(_ line: Line) {
        results[line.id] = nil
    }

    /// Asks Listora how the followed reads go until each ended, or `followFor` passed.
    private func follow() {
        guard follower == nil, !following.isEmpty else { return }
        follower = Task { [weak self] in
            guard let self else { return }
            var waited: Duration = .zero
            while !following.isEmpty, waited < followFor {
                do {
                    try await sleep(lookEvery)
                } catch {
                    break
                }
                waited += lookEvery
                await refreshStatus()
                settle()
            }
            following = []
            follower = nil
        }
    }

    /// Each followed marketplace whose reads ended (on Listora's side, and on this phone) shows
    /// what they found.
    private func settle() {
        let running = Set((progress?.progress ?? []).map(\.marketplace))
        for marketplace in following where !running.contains(marketplace) {
            guard let status = statuses.first(where: { $0.marketplace == marketplace }) else {
                following.remove(marketplace)
                continue
            }
            guard status.state != .syncing else { continue }
            following.remove(marketplace)
            finished(status)
        }
    }

    private func finished(_ status: MarketplaceSyncStatus) {
        let text = "\(Self.name(status.marketplace)): \(status.statusText)"
        switch status.state {
        case .failed:
            results[status.marketplace] = Line(id: status.marketplace, text: text, kind: .failed)
        case .synced:
            show(Line(id: status.marketplace, text: text, kind: .found))
        case .syncing, .notSynced:
            break
        }
    }

    /// Shows a result for `resultFor`.
    private func show(_ line: Line) {
        results[line.id] = line
        Task { [weak self, sleep, resultFor] in
            try? await sleep(resultFor)
            guard let self, results[line.id] == line else { return }
            results[line.id] = nil
        }
    }

    static let listora = "listora"

    static func name(_ marketplace: String) -> String {
        ListingMarketplace(rawValue: marketplace)?.displayName ?? marketplace.capitalized
    }

    /// The phone's work in plain words, from its purpose.
    static func doing(_ purpose: String?, on marketplace: String) -> String {
        let name = name(marketplace)
        return switch purpose {
        case "sale_check": "Checking \(name) sales..."
        case "sale_history": "Reading your \(name) sales history..."
        case "offer_check": "Checking \(name) offers..."
        case "offer_response": "Answering a \(name) offer..."
        case "listing_import": "Reading your \(name) listings..."
        case "session_check": "Checking your \(name) sign-in..."
        case "label_read": "Reading a \(name) shipping label..."
        case "operation": "Updating your \(name) listing..."
        default: "Working on \(name)..."
        }
    }
}
