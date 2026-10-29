import APIClient
import Core
import Foundation
import Testing
@testable import PhoneExecutionFeature

/// The runner's waits, recorded: the first waits until it is canceled, after `during` starts a
/// run (as linking a marketplace does while the app waits); the second ends the follow loop, as
/// the app leaving the foreground cancels it.
@MainActor
final class InterruptedSleeps {
    private(set) var slept: [Duration] = []
    private let during: @MainActor () -> Void

    init(during: @escaping @MainActor () -> Void) {
        self.during = during
    }

    func sleep(_ duration: Duration) async throws {
        slept.append(duration)
        guard slept.count == 1 else {
            throw CancellationError()
        }
        during()
        try await Task.sleep(for: .seconds(60))
    }
}

/// The runner's waits, recorded; the `until`th and every later one end the follow loop, as the
/// app leaving the foreground cancels it.
@MainActor
final class Sleeps {
    private(set) var slept: [Duration] = []
    private let until: Int

    init(until: Int) {
        self.until = until
    }

    func sleep(_ duration: Duration) throws {
        slept.append(duration)
        if slept.count >= until {
            throw CancellationError()
        }
    }
}

extension PhoneRun.Call {
    static func call(_ index: Int) -> PhoneRun.Call {
        PhoneRun.Call(index: index, input: Data(#"{"index":\#(index)}"#.utf8))
    }
}

/// One scripted server reply.
enum Reply {
    var isWait: Bool {
        if case .wait = self {
            return true
        }
        return false
    }

    case run(PhoneRun)
    case none
    /// Nothing to run; ask again after this.
    case wait(Duration)
    case over
    case unreachable
    case conflict
}

actor FakeWorkService: PhoneWorkService {
    private var claimReplies: [Reply]
    private var answerReplies: [String: [Reply]] = [:]
    private(set) var claims = 0
    private(set) var answered: [String] = []
    private(set) var answers: [Data] = []
    private(set) var registrations: [DeviceRegistration] = []
    /// What each claim said: the runs the phone still ran, and whether the app was open.
    private(set) var claimedWith: [(running: [String], appOpen: Bool)] = []
    /// What each wait for work answers, in order (`true`: work reached the phone); once none are
    /// left, the server has no waits, as an older one doesn't.
    private var waitReplies: [Bool] = []
    /// The longest each wait for work was asked to take.
    private(set) var waited: [Duration] = []

    init(claims: [Reply]) {
        claimReplies = claims
    }

    func script(waits: [Bool]) {
        waitReplies = waits
    }

    func waitForWork(installationID: String, upTo: Duration) async throws(APIFailure) -> Bool {
        #expect(installationID == "install-1")
        guard !waitReplies.isEmpty else {
            throw APIFailure(statusCode: 404, code: "not_found", message: "No waits here.", retryable: false)
        }
        waited.append(upTo)
        return waitReplies.removeFirst()
    }

    func script(answers: [String: [Reply]]) {
        answerReplies = answers
    }

    func register(installationID _: String, _ device: DeviceRegistration) async throws(APIFailure) {
        registrations.append(device)
    }

    func runtime(have _: String?) async throws(APIFailure) -> RemoteRuntime {
        RemoteRuntime(digest: "bundled", source: nil, runtimeVersion: 3, signature: nil)
    }

    func claim(
        installationID: String,
        runtimeVersion: Int,
        running: [String],
        appOpen: Bool,
    ) async throws(APIFailure) -> PhoneClaim {
        #expect(installationID == "install-1")
        #expect(runtimeVersion == 1)
        claims += 1
        claimedWith.append((running, appOpen))
        guard !claimReplies.isEmpty else { return PhoneClaim(run: nil) }
        // A last "ask again in" goes on being the answer, as the server's would.
        let reply = claimReplies.count == 1 && claimReplies[0].isWait ? claimReplies[0] : claimReplies.removeFirst()
        if case let .wait(duration) = reply {
            return PhoneClaim(run: nil, nextClaimIn: duration)
        }
        return try PhoneClaim(run: Self.resolve(reply))
    }

    func answer(
        runID: String,
        index: Int,
        answer: Data,
        installationID _: String,
    ) async throws(APIFailure) -> PhoneRun? {
        answered.append("\(runID):\(index)")
        answers.append(answer)
        guard var replies = answerReplies[runID], !replies.isEmpty else { return nil }
        let reply = replies.removeFirst()
        answerReplies[runID] = replies
        return try Self.resolve(reply)
    }

    private static func resolve(_ reply: Reply) throws(APIFailure) -> PhoneRun? {
        switch reply {
        case let .run(run): run
        case .none, .over, .wait: nil
        case .unreachable:
            throw APIFailure(statusCode: nil, code: "network", message: "Listora couldn't be reached.", retryable: true)
        case .conflict:
            throw APIFailure(statusCode: 409, code: "conflict", message: "The run moved on.", retryable: false)
        }
    }
}

@MainActor
final class FakeRuntime: PhoneRuntime {
    static let answer = Data(#"{"kind":"result"}"#.utf8)
    private(set) var ran: [String] = []
    private(set) var maxConcurrent = 0
    private var running = 0
    var fails = false
    /// What each call answers.
    var output = FakeRuntime.answer
    /// The steps each call runs (label, seconds), reported as the runtime reports them.
    var steps: [(String, Double)] = []
    var clock: TestClock?
    /// Runs as each step starts, after the runner heard of it.
    var onStep: (() -> Void)?
    /// Runs during the first call (a trigger arriving mid-run).
    var onRun: (() -> Void)?
    private var stepStarted: (@MainActor (PhoneStep) -> Void)?
    /// Each call waits until this many calls run at once (marketplaces side by side).
    var holdUntilRunning = 0
    private var held: [CheckedContinuation<Void, Never>] = []
    /// Marketplaces whose calls take a while (they yield many times before they answer).
    var slow: Set<String> = []
    /// Calls in the order they answered.
    private(set) var finished: [String] = []
    /// What the runner said about keeping web views warm, in order.
    private(set) var warm: [Bool] = []
    /// How many times the runner checked the runtime against the server's.
    private(set) var refreshes = 0
    /// Whether each check got the server's answer, in order; `true` once none are left.
    var refreshAnswers: [Bool] = []

    func refresh() async -> Bool {
        refreshes += 1
        return refreshAnswers.isEmpty ? true : refreshAnswers.removeFirst()
    }

    func runtimeVersion() async throws -> Int {
        1
    }

    func keepWarm(_ warm: Bool) {
        self.warm.append(warm)
    }

    func observeSteps(_ handler: @escaping @MainActor (PhoneStep) -> Void) {
        stepStarted = handler
    }

    func run(_ input: Data, marketplace: String) async throws -> Data {
        running += 1
        maxConcurrent = max(maxConcurrent, running)
        defer { running -= 1 }
        if fails {
            throw PhoneRuntimeError.invalidAnswer
        }
        let index = (try? JSONSerialization.jsonObject(with: input) as? [String: Int])?["index"] ?? -1
        ran.append("\(marketplace):\(index)")
        if let onRun {
            self.onRun = nil
            onRun()
        }
        if holdUntilRunning > 0 {
            if running >= holdUntilRunning {
                held.forEach { $0.resume() }
                held = []
            } else {
                await withCheckedContinuation { held.append($0) }
            }
        }
        for (index, (label, seconds)) in steps.enumerated() {
            stepStarted?(PhoneStep(marketplace: marketplace, call: "create", index: index + 1, label: label))
            onStep?()
            clock?.step(taking: seconds)
        }
        for _ in 0 ..< (slow.contains(marketplace) ? 200 : 1) {
            await Task.yield()
        }
        finished.append("\(marketplace):\(index)")
        return output
    }
}
