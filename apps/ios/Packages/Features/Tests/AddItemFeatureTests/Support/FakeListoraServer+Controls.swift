import Foundation

/// What a test changes on the fake behind the queue's back: files that arrived while the app was
/// not running, forgotten keys, targets about to expire.
extension FakeListoraServer {
    /// Marks a file as uploaded without receiving its bytes through a request, as when a
    /// transfer finished while the app was not running.
    func markUploaded(fileID: String, bytes: Data) {
        state.withLock { state in
            state.files[fileID]?.status = "uploaded"
            state.files[fileID]?.bytes = bytes
        }
    }

    /// Drops every stored `Idempotency-Key` answer, as the server does after 24 hours.
    func forgetIdempotencyKeys() {
        state.withLock { $0.replays = [:] }
    }

    /// Makes a file's upload target expire at `date`, as the server caps it at the session's
    /// expiry.
    func expireTarget(ofFile fileID: String, at date: Date) {
        let expiresAt = date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        state.withLock { $0.files[fileID]?.targetExpiresAt = expiresAt }
    }
}
