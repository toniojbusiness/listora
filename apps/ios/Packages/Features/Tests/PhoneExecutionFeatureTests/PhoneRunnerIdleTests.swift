import APIClient
import Core
import Foundation
import Testing
@testable import PhoneExecutionFeature

/// The open app between runs: it claims when Listora says work reached the phone, and otherwise
/// stays quiet, so the phone's radio can sleep.
@MainActor
struct PhoneRunnerIdleTests {
    @Test
    func `while nothing reaches this phone, it waits without claiming, but for a claim every few minutes`() async {
        let service = FakeWorkService(claims: [.none])
        await service.script(waits: [false, false, false, false])
        // Each wait takes 100 seconds; the fourth ends the follow loop.
        let clock = ManualClock()
        let sleeps = Sleeps(until: 4)
        let runner = makeRunner(service, FakeRuntime(), clock: clock) { duration in
            await clock.advance(by: 100)
            try await sleeps.sleep(duration)
        }

        await runner.follow()

        // The claims as the app opened, and after 300 seconds; none after the other waits.
        #expect(await service.claims == 2)
        #expect(await service.waited.count == 4)
    }

    @Test
    func `claims as soon as a wait says work is ready, and checks the runtime once while the app is open`() async {
        let service = FakeWorkService(claims: [
            .none,
            .run(PhoneRun(id: "run-1", purpose: "operation", marketplace: "depop", call: .call(0))),
            .none,
        ])
        await service.script(answers: ["run-1": [.over]])
        await service.script(waits: [true, true, false])
        let runtime = FakeRuntime()
        let sleeps = Sleeps(until: 3)
        let runner = makeRunner(service, runtime, clock: ManualClock()) { try await sleeps.sleep($0) }

        await runner.follow()

        #expect(runtime.ran == ["depop:0"])
        #expect(await service.claims >= 3)
        #expect(runtime.refreshes == 1)
    }

    @Test
    func `a runtime check Listora didn't answer is tried again at the next claim`() async {
        let service = FakeWorkService(claims: [.none])
        await service.script(waits: [true, true, false])
        let runtime = FakeRuntime()
        runtime.refreshAnswers = [false]
        let sleeps = Sleeps(until: 3)
        let runner = makeRunner(service, runtime, clock: ManualClock()) { try await sleeps.sleep($0) }

        await runner.follow()

        #expect(runtime.refreshes == 2)
        #expect(await service.claims == 3)
    }

    @Test
    func `the app coming back to the front checks the runtime again`() async {
        let service = FakeWorkService(claims: [.none])
        let runtime = FakeRuntime()
        let runner = makeRunner(service, runtime, clock: ManualClock()) { _ in throw CancellationError() }

        await runner.follow()
        await runner.follow()

        #expect(runtime.refreshes == 2)
    }

    private func makeRunner(
        _ service: FakeWorkService,
        _ runtime: FakeRuntime,
        clock: ManualClock,
        sleep: @escaping @Sendable (Duration) async throws -> Void,
    ) -> PhoneRunner {
        PhoneRunner(
            service: service,
            runtime: runtime,
            installationID: { "install-1" },
            isSignedIn: { true },
            device: { DeviceRegistration(name: "Test iPhone", appVersion: "1.0", runtimeVersion: 0) },
            sleep: sleep,
            timings: StepTimings(defaults: UserDefaults(suiteName: UUID().uuidString) ?? .standard),
            now: { clock.now },
        )
    }
}

/// The time the runner reads, moved on by hand.
@MainActor
final class ManualClock {
    private(set) var now = Date(timeIntervalSince1970: 0)

    func advance(by seconds: TimeInterval) {
        now += seconds
    }
}
