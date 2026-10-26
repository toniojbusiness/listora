import APIClient
import Core
import Foundation
import Testing
@testable import PhoneExecutionFeature

/// The phone runner against a scripted server and runtime: it runs every call the server hands
/// this phone, answers each, and stops only when nothing waits. It never decides an outcome.
@MainActor
struct PhoneRunnerTests {
    @Test
    func `runs each call of the work waiting for this phone and answers it, until none waits`() async {
        let service = FakeWorkService(claims: [
            .run(PhoneRun(id: "run-1", purpose: "listing", marketplace: "depop", call: .call(0))),
            .run(PhoneRun(id: "run-2", purpose: "sale_check", marketplace: "mercari", call: .call(0))),
            .none,
        ])
        await service.script(answers: [
            "run-1": [.run(PhoneRun(id: "run-1", purpose: "listing", marketplace: "depop", call: .call(1))), .over],
            "run-2": [.over],
        ])
        let runtime = FakeRuntime()
        let runner = makeRunner(service, runtime)

        await runner.runUntilDone(.opened)

        #expect(runtime.ran == ["depop:0", "depop:1", "mercari:0"])
        #expect(await service.answered == ["run-1:0", "run-1:1", "run-2:0"])
        #expect(await service.claims == 3)
        #expect(await service.registrations.map(\.runtimeVersion) == [1])
        #expect(runner.activity == .idle)
        #expect(runner.problem == nil)
        #expect(runner.lastRunAt != nil)
    }

    @Test
    func `does nothing while signed out`() async {
        let service = FakeWorkService(claims: [.none])
        let runner = makeRunner(service, FakeRuntime(), signedIn: false)

        await runner.runUntilDone(.opened)

        #expect(await service.claims == 0)
        #expect(await service.registrations.isEmpty)
    }

    @Test
    func `a trigger during a run looks for work again once the run ends, one run at a time`() async {
        let service = FakeWorkService(claims: [
            .run(PhoneRun(id: "run-1", purpose: "listing", marketplace: "depop", call: .call(0))),
            .none,
            .run(PhoneRun(id: "run-2", purpose: "sale_check", marketplace: "depop", call: .call(0))),
            .none,
        ])
        await service.script(answers: ["run-1": [.over], "run-2": [.over]])
        let runtime = FakeRuntime()
        let runner = makeRunner(service, runtime)
        // The push for the second sale arrives while the first run is under way.
        runtime.onRun = { runner.runPhoneWork(.push) }

        await runner.runUntilDone(.opened)

        #expect(runtime.ran == ["depop:0", "depop:0"])
        #expect(runtime.maxConcurrent == 1)
        #expect(await service.claims == 4)
        // The server already knows this device: the second run does not register it again.
        #expect(await service.registrations.count == 1)
    }

    @Test
    func `answers again while Listora can't be reached, with the same answer`() async {
        let service = FakeWorkService(claims: [
            .run(PhoneRun(id: "run-1", purpose: "listing", marketplace: "depop", call: .call(0))),
            .none,
        ])
        await service.script(answers: ["run-1": [.unreachable, .over]])
        let runner = makeRunner(service, FakeRuntime())

        await runner.runUntilDone(.opened)

        #expect(await service.answered == ["run-1:0", "run-1:0"])
        #expect(await service.answers.allSatisfy { $0 == FakeRuntime.answer })
        #expect(runner.problem == nil)
    }

    @Test
    func `stops answering a run the server moved on from, and claims the next`() async {
        let service = FakeWorkService(claims: [
            .run(PhoneRun(id: "run-1", purpose: "listing", marketplace: "depop", call: .call(0))),
            .none,
        ])
        await service.script(answers: ["run-1": [.conflict]])
        let runner = makeRunner(service, FakeRuntime())

        await runner.runUntilDone(.opened)

        #expect(await service.answered == ["run-1:0"])
        #expect(await service.claims == 2)
        #expect(runner.problem == nil)
    }

    @Test
    func `says why when Listora can't be reached, and leaves the work for the next run`() async {
        let service = FakeWorkService(claims: [.unreachable])
        let runner = makeRunner(service, FakeRuntime())

        await runner.runUntilDone(.backgroundRefresh)

        #expect(runner.problem == "Listora couldn't be reached.")
        #expect(runner.activity == .idle)
    }

    @Test
    func `a call the runtime could not run is never answered`() async {
        let service = FakeWorkService(claims: [
            .run(PhoneRun(id: "run-1", purpose: "listing", marketplace: "depop", call: .call(0))),
            .none,
        ])
        let runtime = FakeRuntime()
        runtime.fails = true
        let runner = makeRunner(service, runtime)

        await runner.runUntilDone(.opened)

        // Its claim lapses on the server, which recovers the work.
        #expect(await service.answered.isEmpty)
        #expect(runner.problem == "Listora couldn't run this on your iPhone.")
    }

    @Test
    func `registers again when the push token arrives`() async {
        let service = FakeWorkService(claims: [.none, .none])
        let runner = makeRunner(service, FakeRuntime())
        await runner.runUntilDone(.opened)

        runner.pushTokenChanged("ab12", environment: "sandbox")
        await runner.runUntilDone(.opened)

        let registrations = await service.registrations
        #expect(registrations.count == 2)
        #expect(registrations.last?.pushToken == "ab12")
        #expect(registrations.last?.pushEnvironment == "sandbox")
    }

    @Test
    func `registers this phone before a link names it, once`() async {
        let service = FakeWorkService(claims: [.none])
        let runner = makeRunner(service, FakeRuntime())

        await runner.prepareForWork()
        await runner.prepareForWork()
        await runner.runUntilDone(.userAction)

        #expect(await service.registrations.count == 1)
    }

    private func makeRunner(_ service: FakeWorkService, _ runtime: FakeRuntime, signedIn: Bool = true) -> PhoneRunner {
        PhoneRunner(
            service: service,
            runtime: runtime,
            installationID: { "install-1" },
            isSignedIn: { signedIn },
            device: { DeviceRegistration(name: "Test iPhone", appVersion: "1.0", runtimeVersion: 0) },
            sleep: { _ in },
        )
    }
}

extension PhoneRun.Call {
    static func call(_ index: Int) -> PhoneRun.Call {
        PhoneRun.Call(index: index, input: Data(#"{"index":\#(index)}"#.utf8))
    }
}

/// One scripted server reply.
enum Reply {
    case run(PhoneRun)
    case none
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

    init(claims: [Reply]) {
        claimReplies = claims
    }

    func script(answers: [String: [Reply]]) {
        answerReplies = answers
    }

    func register(installationID _: String, _ device: DeviceRegistration) async throws(APIFailure) {
        registrations.append(device)
    }

    func claim(installationID: String, runtimeVersion: Int) async throws(APIFailure) -> PhoneRun? {
        #expect(installationID == "install-1")
        #expect(runtimeVersion == 1)
        claims += 1
        guard !claimReplies.isEmpty else { return nil }
        return try Self.resolve(claimReplies.removeFirst())
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
        case .none, .over: nil
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
    /// Runs during the first call (a trigger arriving mid-run).
    var onRun: (() -> Void)?

    func runtimeVersion() async throws -> Int {
        1
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
        await Task.yield()
        return Self.answer
    }
}
