import APIClient
import Core
import Foundation
import Observation

/// Runs the marketplace work Listora's server hands this phone (docs/features/phone-execution.md):
/// it claims the work waiting for this device, runs each script call in the phone runtime, and
/// answers, until nothing waits. The server decides everything from the answers; the phone
/// never reports anything as done itself.
///
/// Marketplaces run side by side, each in a lane of its own (its own web views in the runtime):
/// the runner claims for every marketplace with no run under way, naming the runs it still runs,
/// so the server hands out one run per marketplace, delists after a sale first. It runs while the
/// app is open (at once, again whenever Listora says, and as a marketplace's run ends), after the
/// seller links a marketplace or changes a listing, on a push, on background app refresh, and
/// overnight while the phone charges. A trigger during a claim makes it look again after.
@MainActor
@Observable
public final class PhoneRunner: PhoneWorkTrigger, PhoneWorkProgressSource {
    public enum Activity: Equatable, Sendable {
        case idle
        /// Running work on these marketplaces, side by side, in order.
        case running(marketplaces: [String])
    }

    public private(set) var activity: Activity = .idle {
        didSet {
            // The phone stays awake while it works, so a run the seller watches isn't cut off.
            if (activity == .idle) != (oldValue == .idle) {
                keepAwake(activity != .idle)
            }
        }
    }

    /// Where the work running now is, one per marketplace (its step, and about how long it has
    /// left), in marketplace order; empty while nothing runs.
    public var progress: [PhoneWorkProgress] {
        progressByMarketplace.keys.sorted().compactMap { progressByMarketplace[$0] }
    }

    var progressByMarketplace: [String: PhoneWorkProgress] = [:]
    /// Why the work stopped before it was done (the app needs an update, Listora couldn't be
    /// reached, a call couldn't run here); `nil` once claims and runs get through again.
    public var problem: String? {
        claimProblem ?? runProblem
    }

    /// Why the last claim didn't get through; `nil` once one does.
    private var claimProblem: String?
    /// Why a marketplace's run last stopped early; `nil` once a run gets through.
    private var runProblem: String?
    public private(set) var lastRunAt: Date?
    /// How long until the next look while the app is open, as Listora said after its last claim.
    var nextLook: Duration?
    /// The open app's wait until its next look (`follow`), and whether a trigger meanwhile ended
    /// it early: the claim it started says when to look next, which can be much sooner (Listora
    /// answers 5 minutes while no marketplace runs here, seconds once one is linked).
    private var followWait: Task<Void, any Error>?
    private var wokeEarly = false

    let service: any PhoneWorkService
    private let runtime: any PhoneRuntime
    let installationID: @Sendable () -> String
    private let isSignedIn: @MainActor () -> Bool
    private let isAppOpen: @MainActor () -> Bool
    private let device: @MainActor () -> DeviceRegistration
    let sleep: @Sendable (Duration) async throws -> Void
    private let keepAwake: @MainActor (Bool) -> Void
    let timings: StepTimings
    private var pushToken: (token: String, environment: String)?
    /// The registration the server has, so a run registers only when something changed.
    private var registered: DeviceRegistration?
    /// The run each marketplace runs now.
    private var lanes: [String: Lane] = [:]
    /// The claims under way, for every marketplace with no run.
    private var claiming: Task<Void, Never>?
    private var again = false
    /// Runs started since the phone was last idle: at most `maxRuns`, so a stretch of work ends.
    private var started = 0
    private let maxRuns: Int
    private var claimsDone: [CheckedContinuation<Void, Never>] = []
    private var idle: [CheckedContinuation<Void, Never>] = []
    /// The wait between looks while the app is open when Listora said nothing (it couldn't be
    /// reached).
    static let fallbackLook: Duration = .seconds(30)

    private struct Lane {
        let run: PhoneRun
        let task: Task<Void, Never>
    }

    public convenience init(
        service: any PhoneWorkService,
        runtime: any PhoneRuntime,
        installationID: @escaping @Sendable () -> String = Installation.id,
        isSignedIn: @escaping @MainActor () -> Bool,
        isAppOpen: @escaping @MainActor () -> Bool = { false },
        device: @escaping @MainActor () -> DeviceRegistration,
        maxRuns: Int = 50,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        keepAwake: @escaping @MainActor (Bool) -> Void = { _ in },
    ) {
        self.init(
            service: service,
            runtime: runtime,
            installationID: installationID,
            isSignedIn: isSignedIn,
            isAppOpen: isAppOpen,
            device: device,
            maxRuns: maxRuns,
            sleep: sleep,
            keepAwake: keepAwake,
            timings: StepTimings(),
        )
    }

    init(
        service: any PhoneWorkService,
        runtime: any PhoneRuntime,
        installationID: @escaping @Sendable () -> String = Installation.id,
        isSignedIn: @escaping @MainActor () -> Bool,
        isAppOpen: @escaping @MainActor () -> Bool = { false },
        device: @escaping @MainActor () -> DeviceRegistration,
        maxRuns: Int = 50,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        keepAwake: @escaping @MainActor (Bool) -> Void = { _ in },
        timings: StepTimings,
    ) {
        self.service = service
        self.runtime = runtime
        self.installationID = installationID
        self.isSignedIn = isSignedIn
        self.isAppOpen = isAppOpen
        self.device = device
        self.maxRuns = maxRuns
        self.sleep = sleep
        self.keepAwake = keepAwake
        self.timings = timings
        runtime.observeSteps { [weak self] step in self?.stepStarted(step) }
    }

    /// Runs the waiting work now, in the background of the app; returns at once.
    public func runPhoneWork(_: PhoneWorkReason) {
        start()
    }

    /// Runs the waiting work and returns when it is all done, on every marketplace (a background
    /// task, a push).
    public func runUntilDone(_ reason: PhoneWorkReason) async {
        runPhoneWork(reason)
        await whenIdle()
    }

    /// While the app is open: runs the waiting work now, then looks again the moment Listora says
    /// work reached this phone (`waitForWork`; on its own timer when Listora can't say) and as a
    /// marketplace's run ends, so work queued or due meanwhile (a delist after a sale) starts
    /// within a second with no push (iOS may drop one, and a personal team's build gets none),
    /// even while another marketplace works. The runtime keeps a web view per marketplace ready
    /// meanwhile. Returns once the calling task is canceled (the app left).
    public func follow() async {
        runtime.keepWarm(true)
        defer { runtime.keepWarm(false) }
        var woken = false
        while !Task.isCancelled {
            if !woken {
                start()
            }
            // A trigger meanwhile (linking, a change in the app, a push) started the claims
            // already: wait for them, then look again when their last claim said.
            await whenClaimed()
            let wait = Task { try await self.waitForWork() }
            followWait = wait
            do {
                try await withTaskCancellationHandler {
                    try await wait.value
                } onCancel: {
                    wait.cancel()
                }
                woken = false
            } catch {
                guard wokeEarly, !Task.isCancelled else {
                    followWait = nil
                    return
                }
                woken = true
            }
            wokeEarly = false
            followWait = nil
        }
    }

    public func prepareForWork() async {
        guard isSignedIn() else { return }
        do {
            let version = try await runtime.runtimeVersion()
            try await register(installationID(), version)
        } catch {
            // Linking says why: Listora doesn't know this iPhone yet.
        }
    }

    /// The device's APNs token changed: the server learns it on the next run.
    public func pushTokenChanged(_ token: String, environment: String) {
        pushToken = (token, environment)
        start()
    }
}

/// The claims, each marketplace's lane, and the calls of a run.
extension PhoneRunner {
    /// Claims work for every marketplace with no run under way (a trigger during the claims
    /// makes them look again once they end).
    private func start() {
        if let followWait {
            wokeEarly = true
            followWait.cancel()
        }
        if claiming != nil {
            again = true
            return
        }
        claiming = Task { @MainActor in
            repeat {
                again = false
                await claimAll()
            } while again
            claiming = nil
            let waiting = claimsDone
            claimsDone = []
            waiting.forEach { $0.resume() }
            finishIfIdle()
        }
    }

    /// Claims until nothing (more) waits for a free marketplace, starting each claimed run in
    /// its marketplace's lane at once.
    private func claimAll() async {
        // Only a claim that found nothing says when to look next.
        nextLook = nil
        guard isSignedIn() else { return }
        // The scripts the server runs its answers through, when they changed since the last run;
        // only while no marketplace runs, since a new runtime replaces their web views.
        if lanes.isEmpty {
            await runtime.refresh()
        }
        let id = installationID()
        let version: Int
        do {
            version = try await runtime.runtimeVersion()
        } catch {
            claimProblem = "Listora couldn't start its marketplace runner on this iPhone."
            return
        }
        do {
            try await register(id, version)
        } catch {
            claimProblem = error.message
            return
        }
        while started < maxRuns {
            let claimed: PhoneClaim
            do {
                claimed = try await service.claim(
                    installationID: id,
                    runtimeVersion: version,
                    running: lanes.values.map(\.run.id).sorted(),
                    appOpen: isAppOpen(),
                )
            } catch {
                claimProblem = error.message
                return
            }
            guard let run = claimed.run else {
                claimProblem = nil
                nextLook = claimed.nextClaimIn
                return
            }
            started += 1
            startLane(run, installationID: id)
        }
    }

    /// Runs the claimed run in its marketplace's lane; once it ends, the marketplace is free and
    /// the runner claims again. The server hands out one run per marketplace at a time; should it
    /// hand out another, that one waits for the first.
    private func startLane(_ run: PhoneRun, installationID id: String) {
        let before = lanes[run.marketplace]?.task
        let task = Task { @MainActor in
            await before?.value
            let finished = await runCalls(of: run, installationID: id)
            if lanes[run.marketplace]?.run.id == run.id {
                lanes[run.marketplace] = nil
                progressByMarketplace[run.marketplace] = nil
            }
            updateActivity()
            if finished {
                NotificationCenter.default.post(name: .phoneWorkFinished, object: nil)
                start()
            }
            finishIfIdle()
        }
        lanes[run.marketplace] = Lane(run: run, task: task)
        updateActivity()
    }

    private func updateActivity() {
        activity = lanes.isEmpty ? .idle : .running(marketplaces: lanes.keys.sorted())
    }

    /// Returns once the claims under way (if any) ended.
    private func whenClaimed() async {
        guard claiming != nil else { return }
        await withCheckedContinuation { claimsDone.append($0) }
    }

    /// Returns once nothing runs or claims.
    private func whenIdle() async {
        guard claiming != nil || !lanes.isEmpty else { return }
        await withCheckedContinuation { idle.append($0) }
    }

    private func finishIfIdle() {
        guard claiming == nil, lanes.isEmpty else { return }
        started = 0
        lastRunAt = Date()
        let waiting = idle
        idle = []
        waiting.forEach { $0.resume() }
    }

    /// Runs each call of the run and answers it, until the run is over; `false` when a call
    /// could not run on this phone (the run stops; the server recovers the work).
    private func runCalls(of claimed: PhoneRun, installationID id: String) async -> Bool {
        var run = claimed
        while let call = run.call {
            track(run)
            timings.begin(run.marketplace)
            let answer: Data
            do {
                answer = try await runtime.run(call.input, marketplace: run.marketplace)
            } catch {
                timings.finish(run.marketplace, completed: false)
                // The call never ran: the server recovers the work when this phone next asks for
                // work, or once its claim lapses.
                runProblem = "Listora couldn't run this on your iPhone."
                return false
            }
            timings.finish(run.marketplace, completed: Self.ranToTheEnd(answer))
            guard let next = await send(answer, for: call, of: run, installationID: id) else { break }
            run = next
        }
        return true
    }

    /// Answers a call, trying again a few times while Listora can't be reached (the answer is
    /// idempotent); `nil` when the run is over, or the answer could not be sent.
    private func send(
        _ answer: Data,
        for call: PhoneRun.Call,
        of run: PhoneRun,
        installationID: String,
    ) async -> PhoneRun? {
        for attempt in 1 ... 3 {
            do {
                let next = try await service.answer(
                    runID: run.id,
                    index: call.index,
                    answer: answer,
                    installationID: installationID,
                )
                runProblem = nil
                return next
            } catch {
                let unreachable = error.statusCode == nil || (error.statusCode ?? 0) >= 500
                guard unreachable, attempt < 3 else {
                    if !unreachable {
                        // The run is over (404) or moved on (409): claim the next.
                        return nil
                    }
                    runProblem = error.message
                    return nil
                }
                try? await sleep(.seconds(attempt * 2))
            }
        }
        return nil
    }

    private func register(_ id: String, _ version: Int) async throws(APIFailure) {
        var current = device()
        current.runtimeVersion = version
        if let pushToken {
            current.pushToken = pushToken.token
            current.pushEnvironment = pushToken.environment
        }
        guard current != registered else { return }
        try await service.register(installationID: id, current)
        registered = current
    }
}
