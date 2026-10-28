import Foundation

/// The open app's wait between looks (`follow`).
extension PhoneRunner {
    /// The longest one wait for work holds (Listora answers sooner when work arrives).
    static let longestWait: Duration = .seconds(20)
    /// Looks are at least this far apart, however soon Listora says work is ready.
    static let shortestLook: Duration = .seconds(1)
    /// While waits find nothing, the open app still claims this often, in case work reached the
    /// phone in a way the wait missed.
    static let safetyClaim: Duration = .seconds(300)

    /// Listora answers the moment work reaches this phone (a delist after a sale starts within a
    /// second of the engine handing it over), at most `longestWait` later; at most one look a
    /// second. A server without the wait, or one that can't be reached, gets the last claim's own
    /// wait instead, and so does a phone Listora doesn't know yet (signed out, or not registered).
    /// Whether to claim now: when Listora said work is ready, when it couldn't say, and once
    /// `safetyClaim` passed since the last claims.
    func waitForWork() async throws -> Bool {
        guard isSignedIn(), registered != nil else {
            try await sleep(nextLook ?? Self.fallbackLook)
            return true
        }
        let started = ContinuousClock.now
        let ready: Bool
        do {
            ready = try await service.waitForWork(installationID: installationID(), upTo: Self.longestWait)
        } catch {
            try Task.checkCancellation()
            try await sleep(nextLook ?? Self.fallbackLook)
            return true
        }
        let elapsed = ContinuousClock.now - started
        if elapsed < Self.shortestLook {
            try await sleep(Self.shortestLook - elapsed)
        }
        return ready || safetyClaimDue
    }

    private var safetyClaimDue: Bool {
        guard let lastClaimAt else { return true }
        return now().timeIntervalSince(lastClaimAt) >= Double(Self.safetyClaim.components.seconds)
    }
}
