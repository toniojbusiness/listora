import Foundation

/// The marketplace work running on this phone now (docs/features/phone-execution.md), for the
/// screens that show it while it runs: the marketplace, the operation, the step in plain words
/// ("Adding the photos"), its number, and when the run should end, estimated from the same
/// work's earlier runs on this phone.
public struct PhoneWorkProgress: Equatable, Sendable {
    /// The marketplace id (`depop`).
    public let marketplace: String
    /// The listing change the work is for; `nil` for a sign-in or sale check.
    public let operationID: String?
    /// The step running now, in plain words; `nil` before the first step.
    public let step: String?
    /// The step's number in the run, from 1; 0 before the first step.
    public let stepNumber: Int
    /// How many steps the same work took when it last ran to the end here; `nil` until it has.
    public let stepCount: Int?
    /// When the run should end, from the steps' earlier times; `nil` without them.
    public let expectedEnd: Date?

    public init(
        marketplace: String,
        operationID: String?,
        step: String?,
        stepNumber: Int,
        stepCount: Int?,
        expectedEnd: Date?,
    ) {
        self.marketplace = marketplace
        self.operationID = operationID
        self.step = step
        self.stepNumber = stepNumber
        self.stepCount = stepCount
        self.expectedEnd = expectedEnd
    }

    /// The share of the steps done, for a progress bar; `nil` without a step count.
    public var fractionDone: Double? {
        guard let stepCount, stepCount > 0 else { return nil }
        return min(1, Double(max(0, stepNumber - 1)) / Double(stepCount))
    }

    /// Whole seconds left at `now`, at least 1 while the run goes on; `nil` without an estimate.
    public func secondsLeft(at now: Date) -> Int? {
        guard let expectedEnd else { return nil }
        return max(1, Int(expectedEnd.timeIntervalSince(now).rounded(.up)))
    }
}

/// What the screens read to show the work running on this phone (the phone runner).
@MainActor
public protocol PhoneWorkProgressSource: AnyObject {
    /// The work running now, one per marketplace (marketplaces run side by side), in
    /// marketplace order; empty while nothing runs.
    var progress: [PhoneWorkProgress] { get }
}
