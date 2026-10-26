import APIClient
import Core
import Foundation
import Observation

/// Runs the marketplace work Listora's server hands this phone (docs/features/phone-execution.md):
/// it claims the next work waiting for this device, runs each script call in the phone runtime,
/// and answers, until nothing waits. The server decides everything from the answers; the phone
/// never reports anything as done itself.
///
/// It runs while the app is open (at once, then again whenever Listora says to look next), after
/// the seller links a marketplace or changes a listing, when a push notification arrives or is
/// tapped, on background app refresh, and overnight while the phone charges. One run at a time: a
/// trigger during a run makes it look again once it ends.
@MainActor
@Observable
public final class PhoneRunner: PhoneWorkTrigger {
    public enum Activity: Equatable, Sendable {
        case idle
        /// Running work on a marketplace (`purpose`: a listing change, a sign-in check, a sale check).
        case running(marketplace: String, purpose: String)
    }

    public private(set) var activity: Activity = .idle
    /// Why the last run stopped before the work was done (the app needs an update, Listora
    /// couldn't be reached); `nil` once a run gets through.
    public private(set) var problem: String?
    public private(set) var lastRunAt: Date?
    /// How long until the next look while the app is open, as Listora said after its last claim.
    private var nextLook: Duration?
    /// The open app's wait until its next look (`follow`), and whether a run started meanwhile
    /// ended it early: that run's last claim says when to look next, which can be much sooner
    /// (Listora answers 5 minutes while no marketplace runs here, 10 seconds once one is linked).
    private var followWait: Task<Void, any Error>?
    private var wokeEarly = false

    private let service: any PhoneWorkService
    private let runtime: any PhoneRuntime
    private let installationID: @Sendable () -> String
    private let isSignedIn: @MainActor () -> Bool
    private let device: @MainActor () -> DeviceRegistration
    private let sleep: @Sendable (Duration) async throws -> Void
    private var pushToken: (token: String, environment: String)?
    /// The registration the server has, so a run registers only when something changed.
    private var registered: DeviceRegistration?
    private var task: Task<Void, Never>?
    private var again = false
    /// Work one run claims at most, so a run always ends.
    private let maxRuns: Int
    /// The wait between looks while the app is open when Listora said nothing (it couldn't be
    /// reached).
    static let fallbackLook: Duration = .seconds(30)

    public init(
        service: any PhoneWorkService,
        runtime: any PhoneRuntime,
        installationID: @escaping @Sendable () -> String = Installation.id,
        isSignedIn: @escaping @MainActor () -> Bool,
        device: @escaping @MainActor () -> DeviceRegistration,
        maxRuns: Int = 50,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
    ) {
        self.service = service
        self.runtime = runtime
        self.installationID = installationID
        self.isSignedIn = isSignedIn
        self.device = device
        self.maxRuns = maxRuns
        self.sleep = sleep
    }

    /// Runs the waiting work now, in the background of the app; returns at once.
    public func runPhoneWork(_: PhoneWorkReason) {
        start()
    }

    /// Runs the waiting work and returns when it is done (a background task, a push).
    public func runUntilDone(_ reason: PhoneWorkReason) async {
        runPhoneWork(reason)
        await task?.value
    }

    /// While the app is open: runs the waiting work now, then again whenever Listora says to
    /// look next, sooner when work for this phone is due then (a check tried again after a
    /// failed attempt). So work queued or due meanwhile starts within seconds with no push, which
    /// iOS may drop and a build signed with a personal team never gets. Returns once the calling
    /// task is canceled (the app left the foreground).
    public func follow() async {
        var woken = false
        while !Task.isCancelled {
            if woken {
                // A run started meanwhile (linking, a change in the app, a push): wait for it,
                // then look again when its last claim said.
                await task?.value
            } else {
                await runUntilDone(.opened)
            }
            let wait = Task { [sleep, nextLook] in try await sleep(nextLook ?? Self.fallbackLook) }
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

    private func start() {
        if let followWait {
            wokeEarly = true
            followWait.cancel()
        }
        if task != nil {
            again = true
            return
        }
        task = Task { @MainActor in
            repeat {
                again = false
                await runOnce()
            } while again
            task = nil
        }
    }

    private func runOnce() async {
        // Only a claim that found nothing says when to look next.
        nextLook = nil
        guard isSignedIn() else { return }
        let id = installationID()
        let version: Int
        do {
            version = try await runtime.runtimeVersion()
        } catch {
            problem = "Listora couldn't start its marketplace runner on this iPhone."
            return
        }
        do {
            try await register(id, version)
        } catch {
            problem = error.message
            return
        }
        defer {
            activity = .idle
            lastRunAt = Date()
        }
        for _ in 0 ..< maxRuns {
            let claimed: PhoneClaim
            do {
                claimed = try await service.claim(installationID: id, runtimeVersion: version)
            } catch {
                problem = error.message
                return
            }
            guard var run = claimed.run else {
                problem = nil
                nextLook = claimed.nextClaimIn
                return
            }
            while let call = run.call {
                activity = .running(marketplace: run.marketplace, purpose: run.purpose)
                let answer: Data
                do {
                    answer = try await runtime.run(call.input, marketplace: run.marketplace)
                } catch {
                    // The call never ran: the server recovers the work when this phone next asks
                    // for work, or once its claim lapses.
                    problem = "Listora couldn't run this on your iPhone."
                    return
                }
                guard let next = await send(answer, for: call, of: run, installationID: id) else { break }
                run = next
            }
            NotificationCenter.default.post(name: .phoneWorkFinished, object: nil)
        }
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
                return try await service.answer(
                    runID: run.id,
                    index: call.index,
                    answer: answer,
                    installationID: installationID,
                )
            } catch {
                let unreachable = error.statusCode == nil || (error.statusCode ?? 0) >= 500
                guard unreachable, attempt < 3 else {
                    if !unreachable {
                        // The run is over (404) or moved on (409): claim the next.
                        return nil
                    }
                    problem = error.message
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
