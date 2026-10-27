import Foundation

/// The open app's wait between looks (`follow`).
extension PhoneRunner {
    /// The longest one wait for work holds (Listora answers sooner when work arrives).
    static let longestWait: Duration = .seconds(20)
    /// Looks are at least this far apart, however soon Listora says work is ready.
    static let shortestLook: Duration = .seconds(1)

    /// Listora answers the moment work reaches this phone (a delist after a sale starts within a
    /// second of the engine handing it over), at most `longestWait` later; at most one look a
    /// second. A server without the wait, or one that can't be reached, gets the last claim's own
    /// wait instead.
    func waitForWork() async throws {
        let started = ContinuousClock.now
        do {
            _ = try await service.waitForWork(installationID: installationID(), upTo: Self.longestWait)
        } catch {
            try Task.checkCancellation()
            try await sleep(nextLook ?? Self.fallbackLook)
            return
        }
        let elapsed = ContinuousClock.now - started
        if elapsed < Self.shortestLook {
            try await sleep(Self.shortestLook - elapsed)
        }
    }
}
