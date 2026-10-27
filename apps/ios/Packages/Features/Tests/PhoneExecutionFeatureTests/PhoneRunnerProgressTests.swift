import Core
import Foundation
import Testing
@testable import PhoneExecutionFeature

/// The phone runner's progress while it works: the step the runtime reports, its number, and the
/// time left from the same work's last full run here; and the phone kept awake meanwhile.
@MainActor
struct PhoneRunnerProgressTests {
    @Test
    func `shows the step it runs and the time left from the last full run, and keeps the phone awake`() async throws {
        let service = FakeWorkService(claims: [
            .run(PhoneRun(id: "run-1", purpose: "listing", marketplace: "depop", operationID: "op-1", call: .call(0))),
            .run(PhoneRun(id: "run-2", purpose: "listing", marketplace: "depop", operationID: "op-2", call: .call(0))),
            .none,
        ])
        await service.script(answers: ["run-1": [.over], "run-2": [.over]])
        let clock = TestClock()
        let defaults = try #require(UserDefaults(suiteName: "phone-runner-\(UUID().uuidString)"))
        let runtime = FakeRuntime()
        runtime.output = Data(#"{"type":"ran","result":{"ok":true}}"#.utf8)
        runtime.steps = [("Getting the photos", 4), ("Adding the photos", 10), ("Posting", 6)]
        runtime.clock = clock
        var awake: [Bool] = []
        let runner = PhoneRunner(
            service: service,
            runtime: runtime,
            installationID: { "install-1" },
            isSignedIn: { true },
            device: { DeviceRegistration(name: "Test iPhone", appVersion: "1.0", runtimeVersion: 0) },
            sleep: { _ in },
            keepAwake: { awake.append($0) },
            timings: StepTimings(defaults: defaults, clock: { clock.now }),
        )
        var seen: [PhoneWorkProgress?] = []
        runtime.onStep = { seen.append(runner.progress.first) }

        await runner.runUntilDone(.opened)

        // The first run has no earlier one to estimate from: it counts its steps only.
        #expect(seen.prefix(3).map { $0?.stepNumber } == [1, 2, 3])
        #expect(seen.prefix(3).allSatisfy { $0?.stepCount == nil && $0?.expectedEnd == nil })
        #expect(seen[1]?.step == "Adding the photos")
        #expect(seen[1]?.operationID == "op-1")
        // The second knows the steps and their times from the first.
        let second = try #require(seen[4])
        #expect(second.operationID == "op-2")
        #expect(second.stepNumber == 2)
        #expect(second.stepCount == 3)
        #expect(second.expectedEnd == clock.started[4].addingTimeInterval(16))
        #expect(second.secondsLeft(at: clock.started[4]) == 16)
        #expect(second.fractionDone == 1.0 / 3)
        // Nothing runs afterwards, and the phone may sleep again.
        #expect(runner.progress.isEmpty)
        #expect(awake == [true, false])
    }
}

/// A clock the fake runtime moves forward as its steps take time.
@MainActor
final class TestClock {
    var now = Date(timeIntervalSince1970: 1_800_000_000)
    /// When each step the fake runtime ran started, in order.
    private(set) var started: [Date] = []

    func step(taking seconds: Double) {
        started.append(now)
        now = now.addingTimeInterval(seconds)
    }
}
