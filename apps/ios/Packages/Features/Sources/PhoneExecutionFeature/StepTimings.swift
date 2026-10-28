import Core
import Foundation

/// A step the phone runtime started (its `progress` message): the marketplace whose call it is
/// (`depop`; each marketplace runs in its own web views, side by side), the call's name
/// (`create`), the step's number in the run from 1, and what it does in plain words.
public struct PhoneStep: Equatable, Sendable {
    public let marketplace: String
    public let call: String
    public let index: Int
    public let label: String

    public init(marketplace: String, call: String, index: Int, label: String) {
        self.marketplace = marketplace
        self.call = call
        self.index = index
        self.label = label
    }
}

/// How long each step of a call took the last time it ran to the end on this phone, per
/// marketplace and call (`depop`, `create`), so a run can say how many steps it has and about
/// how long it has left. Kept in the app's defaults; a run that stops early changes nothing.
/// Each marketplace's call is timed on its own, since marketplaces run side by side.
@MainActor
final class StepTimings {
    private let defaults: UserDefaults
    private let clock: () -> Date
    private static let prefix = "phone.stepTimings."

    /// The call each marketplace runs now: its key, and when each of its steps started.
    private var runs: [String: (key: String?, started: [Date])] = [:]

    init(defaults: UserDefaults = .standard, clock: @escaping () -> Date = Date.init) {
        self.defaults = defaults
        self.clock = clock
    }

    /// The last full run's step times, in seconds, in order; empty before one.
    func recorded(marketplace: String, call: String) -> [Double] {
        defaults.array(forKey: Self.prefix + Self.key(marketplace, call)) as? [Double] ?? []
    }

    /// The marketplace's call starts: its steps are timed from now.
    func begin(_ marketplace: String) {
        runs[marketplace] = (nil, [])
    }

    /// The call started its `step.index`th step; returns the run's progress with it.
    func started(_ step: PhoneStep, operationID: String?, purpose: String? = nil) -> PhoneWorkProgress {
        let now = clock()
        let marketplace = step.marketplace
        let key = Self.key(marketplace, step.call)
        var (runKey, started) = runs[marketplace] ?? (nil, [])
        if runKey != key || step.index <= started.count - 1 || step.index == 1 {
            // A new call, or the call started over (after a check the seller completed).
            runKey = key
            started = []
        }
        while started.count < step.index {
            started.append(now)
        }
        runs[marketplace] = (runKey, started)
        let earlier = recorded(marketplace: marketplace, call: step.call)
        let known = earlier.count >= step.index
        return PhoneWorkProgress(
            marketplace: marketplace,
            operationID: operationID,
            purpose: purpose,
            step: step.label,
            stepNumber: step.index,
            stepCount: known ? earlier.count : nil,
            expectedEnd: known ? now.addingTimeInterval(earlier[(step.index - 1)...].reduce(0, +)) : nil,
        )
    }

    /// The marketplace's call ended; one that ran to the end keeps its step times for the next.
    func finish(_ marketplace: String, completed: Bool) {
        let run = runs.removeValue(forKey: marketplace)
        guard completed, let key = run?.key, let started = run?.started, !started.isEmpty else { return }
        let ends = started.dropFirst() + [clock()]
        let seconds = zip(started, ends).map { max(0, $1.timeIntervalSince($0)) }
        defaults.set(seconds, forKey: Self.prefix + key)
    }

    private static func key(_ marketplace: String, _ call: String) -> String {
        "\(marketplace).\(call)"
    }
}
