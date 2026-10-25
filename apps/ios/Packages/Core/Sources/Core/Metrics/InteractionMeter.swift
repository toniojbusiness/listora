import Foundation
import os

/// One item being created, measured from its first photo to the saved inventory item: how long the
/// flow's screens were in front of the seller and how many times they tapped.
public struct InteractionSession: Codable, Equatable, Sendable {
    public let id: String
    public let startedAt: Date
    /// Time a screen of the flow was showing with the app in the foreground, waits included.
    public var onScreen: TimeInterval = 0
    /// The part of ``onScreen`` spent waiting on Listora (preparing photos, uploading, analyzing,
    /// saving) with nothing for the seller to do.
    public var waiting: TimeInterval = 0
    /// Taps anywhere in the app while the flow was showing. Typing on the system keyboard is not
    /// counted: the keyboard is not part of the app's window.
    public var taps = 0

    /// The seller's active interaction time: on screen and not waiting.
    public var active: TimeInterval {
        max(0, onScreen - waiting)
    }
}

/// The measurement of one finished item, kept on the device and logged.
public struct InteractionSummary: Codable, Equatable, Sendable {
    /// Listora's goal for a normal item: less than about this much active interaction before it is
    /// ready to list.
    public static let goal: TimeInterval = 30

    public let itemID: String
    public let sku: String
    public let startedAt: Date
    public let finishedAt: Date
    public let active: TimeInterval
    public let waiting: TimeInterval
    public let taps: Int

    public var meetsGoal: Bool {
        active <= Self.goal
    }
}

/// What ``InteractionMeter`` keeps between launches: the sessions in progress and the latest
/// finished items.
public struct InteractionRecords: Codable, Equatable, Sendable {
    public var sessions: [String: InteractionSession] = [:]
    /// Newest last, at most ``InteractionMeter/maxRecentSummaries``.
    public var recent: [InteractionSummary] = []

    public init() {}
}

/// Where ``InteractionMeter`` keeps its records.
public protocol InteractionRecordStorage: Sendable {
    func load() -> InteractionRecords
    func save(_ records: InteractionRecords)
}

/// Keeps the records in `UserDefaults` as JSON.
/// `UserDefaults` is documented as thread-safe but is not marked `Sendable`, hence `@unchecked`.
public struct UserDefaultsInteractionStorage: InteractionRecordStorage, @unchecked Sendable {
    public static let defaultKey = "com.listora.interaction-records"

    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = defaultKey) {
        self.defaults = defaults
        self.key = key
    }

    public func load() -> InteractionRecords {
        guard let data = defaults.data(forKey: key),
              let records = try? JSONDecoder().decode(InteractionRecords.self, from: data)
        else { return InteractionRecords() }
        return records
    }

    public func save(_ records: InteractionRecords) {
        guard let data = try? JSONEncoder().encode(records) else { return }
        defaults.set(data, forKey: key)
    }

    /// Forgets every record (`LISTORA_RESET_LOCAL_DATA`).
    public func reset() {
        defaults.removeObject(forKey: key)
    }
}

/// Keeps the records in memory only: for tests and previews.
public final class InMemoryInteractionStorage: InteractionRecordStorage {
    private let records: OSAllocatedUnfairLock<InteractionRecords>

    public init(_ records: InteractionRecords = InteractionRecords()) {
        self.records = OSAllocatedUnfairLock(initialState: records)
    }

    public func load() -> InteractionRecords {
        records.withLock { $0 }
    }

    public func save(_ records: InteractionRecords) {
        self.records.withLock { $0 = records }
    }
}

/// Measures the seller's active interaction time and taps per item, from the first photo to the
/// saved inventory item, toward the goal of less than about 30 seconds an item
/// (``InteractionSummary/goal``).
///
/// A session's clock runs only while one of its screens is showing (``enter(_:)`` and
/// ``leave(_:)``, counted per session so pushing the next screen of the same flow keeps it going)
/// and the app is in the foreground. Time spent waiting on Listora (``setWaiting(_:for:)``) is
/// counted apart, so ``InteractionSession/active`` is the seller's own time. Taps come from the app
/// window (``recordTap()``) and count toward the session whose screen is showing. Sessions survive
/// relaunches; the metric is local and logged, since the API has no event for it.
@MainActor
public final class InteractionMeter {
    public static let maxRecentSummaries = 50
    /// Sessions this old are dropped: the item was abandoned.
    public static let abandonedAfter: TimeInterval = 7 * 24 * 60 * 60

    private let storage: any InteractionRecordStorage
    private let now: () -> Date
    private let log = Logger(subsystem: "com.listora.app", category: "metrics")
    private var records: InteractionRecords
    /// How many showing screens belong to each session.
    private var visible: [String: Int] = [:]
    /// The most recently entered session first.
    private var entryOrder: [String] = []
    private var waitingIDs: Set<String> = []
    private var isAppActive = true
    private var running: (id: String, since: Date)?

    public init(storage: any InteractionRecordStorage, now: @escaping () -> Date = Date.init) {
        self.storage = storage
        self.now = now
        var records = storage.load()
        let cutoff = now().addingTimeInterval(-Self.abandonedAfter)
        records.sessions = records.sessions.filter { $0.value.startedAt > cutoff }
        self.records = records
    }

    /// Starts measuring `id` (the first photo), unless it is already being measured.
    public func begin(_ id: String) {
        guard records.sessions[id] == nil else { return }
        records.sessions[id] = InteractionSession(id: id, startedAt: now())
        storage.save(records)
        reconcile()
    }

    /// Moves a session to a new id, keeping what it measured: a session that starts before its
    /// draft exists takes the draft's id once it is saved.
    public func rename(_ id: String, to newID: String) {
        guard id != newID else { return }
        fold()
        if let session = records.sessions.removeValue(forKey: id) {
            records.sessions[newID] = InteractionSession(
                id: newID,
                startedAt: session.startedAt,
                onScreen: session.onScreen,
                waiting: session.waiting,
                taps: session.taps,
            )
        }
        if let count = visible.removeValue(forKey: id) {
            visible[newID, default: 0] += count
        }
        entryOrder = entryOrder.map { $0 == id ? newID : $0 }
        if waitingIDs.remove(id) != nil {
            waitingIDs.insert(newID)
        }
        reconcile()
    }

    /// A screen of session `id` appeared.
    public func enter(_ id: String) {
        visible[id, default: 0] += 1
        entryOrder.removeAll { $0 == id }
        entryOrder.insert(id, at: 0)
        reconcile()
    }

    /// A screen of session `id` disappeared.
    public func leave(_ id: String) {
        guard let count = visible[id] else { return }
        if count <= 1 {
            visible[id] = nil
            entryOrder.removeAll { $0 == id }
        } else {
            visible[id] = count - 1
        }
        reconcile()
    }

    /// The app moved to or from the foreground.
    public func setAppActive(_ active: Bool) {
        isAppActive = active
        reconcile()
    }

    /// Whether session `id` is waiting on Listora right now.
    public func setWaiting(_ waiting: Bool, for id: String) {
        guard waitingIDs.contains(id) != waiting else { return }
        fold()
        if waiting {
            waitingIDs.insert(id)
        } else {
            waitingIDs.remove(id)
        }
        reconcile()
    }

    /// A tap in the app window. It counts toward the session whose screen is showing, if any.
    public func recordTap() {
        guard let id = running?.id else { return }
        records.sessions[id]?.taps += 1
    }

    /// The session as measured so far, the running stretch included.
    public func session(_ id: String) -> InteractionSession? {
        fold()
        reconcile()
        return records.sessions[id]
    }

    /// Ends session `id`: its item was saved. Logs and keeps the result, and returns it.
    @discardableResult
    public func finish(_ id: String, itemID: String, sku: String) -> InteractionSummary? {
        fold()
        guard let session = records.sessions.removeValue(forKey: id) else {
            reconcile()
            return nil
        }
        waitingIDs.remove(id)
        let summary = InteractionSummary(
            itemID: itemID,
            sku: sku,
            startedAt: session.startedAt,
            finishedAt: now(),
            active: session.active,
            waiting: session.waiting,
            taps: session.taps,
        )
        records.recent.append(summary)
        records.recent = Array(records.recent.suffix(Self.maxRecentSummaries))
        storage.save(records)
        reconcile()
        let active = summary.active.formatted(.number.precision(.fractionLength(1)))
        let waiting = summary.waiting.formatted(.number.precision(.fractionLength(1)))
        log.info(
            """
            item saved \(sku, privacy: .public): active \(active, privacy: .public) s, \
            waiting \(waiting, privacy: .public) s, \(summary.taps) taps, \
            goal met: \(summary.meetsGoal)
            """,
        )
        return summary
    }

    /// Stops measuring `id` without a result: its draft was deleted.
    public func discard(_ id: String) {
        fold()
        records.sessions[id] = nil
        waitingIDs.remove(id)
        storage.save(records)
        reconcile()
    }

    /// The latest finished items, newest last.
    public var recentSummaries: [InteractionSummary] {
        records.recent
    }

    /// Adds the running stretch to its session and restarts the stretch at now.
    private func fold() {
        guard let current = running else { return }
        let time = now()
        let elapsed = max(0, time.timeIntervalSince(current.since))
        if records.sessions[current.id] != nil {
            records.sessions[current.id]?.onScreen += elapsed
            if waitingIDs.contains(current.id) {
                records.sessions[current.id]?.waiting += elapsed
            }
        }
        running = (current.id, time)
    }

    /// Runs the clock of the session that should be running, if any.
    private func reconcile() {
        let wanted = isAppActive ? entryOrder.first { records.sessions[$0] != nil } : nil
        guard wanted != running?.id else { return }
        fold()
        running = wanted.map { ($0, now()) }
        storage.save(records)
    }
}
