import Core
import Foundation
import Testing
@testable import PhoneExecutionFeature

/// The phone runner with marketplaces side by side: one lane per marketplace, the runs it still
/// runs named in every claim, a free marketplace claiming at once, each marketplace's progress,
/// and the runtime's web views kept warm while the app is open.
@MainActor
struct PhoneRunnerLaneTests {
    @Test
    func `runs marketplaces side by side, naming the runs it still runs when it claims`() async {
        let service = FakeWorkService(claims: [
            .run(.operation("run-1", on: "depop", operationID: "op-1")),
            .run(.operation("run-2", on: "poshmark", operationID: "op-2")),
            .none,
        ])
        await service.script(answers: ["run-1": [.over], "run-2": [.over]])
        let runtime = FakeRuntime()
        // Each call waits until both marketplaces run, so they can only finish side by side.
        runtime.holdUntilRunning = 2
        runtime.steps = [("Posting", 1)]
        var awake: [Bool] = []
        let runner = PhoneRunner(
            service: service,
            runtime: runtime,
            installationID: { "install-1" },
            isSignedIn: { true },
            isAppOpen: { true },
            device: { DeviceRegistration(name: "Test iPhone", appVersion: "1.0", runtimeVersion: 0) },
            sleep: { _ in },
            keepAwake: { awake.append($0) },
        )
        var shown: [[String]] = []
        runtime.onStep = { shown.append(runner.progress.map(\.marketplace)) }

        await runner.runUntilDone(.opened)

        #expect(runtime.maxConcurrent == 2)
        #expect(Set(runtime.ran) == ["depop:0", "poshmark:0"])
        let claimed = await service.claimedWith
        #expect(claimed.first?.running == [])
        #expect(claimed.dropFirst().first?.running == ["run-1"])
        #expect(claimed.dropFirst(2).first?.running == ["run-1", "run-2"])
        let claimedOpen = claimed.allSatisfy(\.appOpen)
        #expect(claimedOpen)
        // Each marketplace shows its own progress while both run.
        #expect(shown.last == ["depop", "poshmark"])
        #expect(runner.progress.isEmpty)
        #expect(runner.activity == .idle)
        #expect(awake == [true, false])
    }

    @Test
    func `a marketplace that finishes claims again at once while another still runs`() async {
        let service = FakeWorkService(claims: [
            .run(.operation("run-1", on: "mercari")),
            .run(.operation("run-2", on: "depop")),
            .none,
            // Depop's run ended first: its next work (a delist) goes at once, Mercari still runs.
            .run(.operation("run-3", on: "depop", call: 1)),
            .none,
        ])
        await service.script(answers: ["run-1": [.over], "run-2": [.over], "run-3": [.over]])
        let runtime = FakeRuntime()
        runtime.slow = ["mercari"]
        let runner = makeRunner(service, runtime)

        await runner.runUntilDone(.opened)

        #expect(runtime.ran.prefix(3).sorted() == ["depop:0", "depop:1", "mercari:0"].sorted())
        #expect(runtime.finished.first == "depop:0")
        #expect(runtime.finished.dropFirst().first == "depop:1")
        let claimed = await service.claimedWith
        #expect(claimed.count > 3)
        #expect(claimed.dropFirst(3).first?.running == ["run-1"])
    }

    @Test
    func `keeps the web views warm while the app is open, and lets them go when it leaves`() async {
        let service = FakeWorkService(claims: [.wait(.seconds(5))])
        let runtime = FakeRuntime()
        let sleeps = Sleeps(until: 1)
        let runner = makeRunner(service, runtime, sleep: { try await sleeps.sleep($0) })

        await runner.follow()

        #expect(runtime.warm == [true, false])
        #expect(sleeps.slept == [.seconds(5)])
    }

    private func makeRunner(
        _ service: FakeWorkService,
        _ runtime: FakeRuntime,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { _ in },
    ) -> PhoneRunner {
        PhoneRunner(
            service: service,
            runtime: runtime,
            installationID: { "install-1" },
            isSignedIn: { true },
            device: { DeviceRegistration(name: "Test iPhone", appVersion: "1.0", runtimeVersion: 0) },
            sleep: sleep,
        )
    }
}

extension PhoneRun {
    /// A listing change's run on `marketplace`, at its call `call`.
    static func operation(_ id: String, on marketplace: String, operationID: String? = nil, call: Int = 0) -> PhoneRun {
        PhoneRun(id: id, purpose: "operation", marketplace: marketplace, operationID: operationID, call: .call(call))
    }
}
