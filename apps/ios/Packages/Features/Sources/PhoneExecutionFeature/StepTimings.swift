import Core
import Foundation

/// A step the phone runtime started (its `progress` message): the call's name (`create`), the
/// step's number in the run from 1, and what it does in plain words.
public struct PhoneStep: Equatable, Sendable {
    public let call: String
    public let index: Int
    public let label: String

    public init(call: String, index: Int, label: String) {
        self.call = call
        self.index = index
        self.label = label
    }
}

/// How long each step of a call took the last time it ran to the end on this phone, per
/// marketplace and call (`depop`, `create`), so a run can say how many steps it has and about
/// how long it has left. Kept in the app's defaults; a run that stops early changes nothing.
@MainActor
final class StepTimings {
    private let defaults: UserDefaults
    private let clock: () -> Date
    private static let prefix = "phone.stepTimings."

    /// The run being timed: its key, and when each of its steps started.
    private var key: String?
    private var started: [Date] = []

    init(defaults: UserDefaults = .standard, clock: @escaping () -> Date = Date.init) {
        self.defaults = defaults
        self.clock = clock
    }

    /// The last full run's step times, in seconds, in order; empty before one.
    func recorded(marketplace: String, call: String) -> [Double] {
        defaults.array(forKey: Self.prefix + Self.key(marketplace, call)) as? [Double] ?? []
    }

    /// A call starts: its steps are timed from now.
    func begin() {
        key = nil
        started = []
    }

    /// The call started its `step.index`th step; returns the run's progress with it.
    func started(
        _ step: PhoneStep,
        marketplace: String,
        operationID: String?,
    ) -> PhoneWorkProgress {
        let now = clock()
        let key = Self.key(marketplace, step.call)
        if self.key != key || step.index <= started.count - 1 || step.index == 1 {
            // A new call, or the call started over (after a check the seller completed).
            self.key = key
            started = []
        }
        while started.count < step.index {
            started.append(now)
        }
        let earlier = recorded(marketplace: marketplace, call: step.call)
        let known = earlier.count >= step.index
        return PhoneWorkProgress(
            marketplace: marketplace,
            operationID: operationID,
            step: step.label,
            stepNumber: step.index,
            stepCount: known ? earlier.count : nil,
            expectedEnd: known ? now.addingTimeInterval(earlier[(step.index - 1)...].reduce(0, +)) : nil,
        )
    }

    /// The call ended; a call that ran to the end keeps its step times for the next run.
    func finish(completed: Bool) {
        defer {
            key = nil
            started = []
        }
        guard completed, let key, !started.isEmpty else { return }
        let ends = started.dropFirst() + [clock()]
        let seconds = zip(started, ends).map { max(0, $1.timeIntervalSince($0)) }
        defaults.set(seconds, forKey: Self.prefix + key)
    }

    private static func key(_ marketplace: String, _ call: String) -> String {
        "\(marketplace).\(call)"
    }
}
