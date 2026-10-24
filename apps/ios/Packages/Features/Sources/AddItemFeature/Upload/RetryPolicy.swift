import Foundation

/// How the upload queue retries a request that failed in a way that may pass later (no network, a
/// timeout, `429`, `5xx`, or an error the server marks `retryable`): exponential backoff with
/// jitter, then a stop that the user sees with a Retry button.
struct RetryPolicy: Sendable {
    /// Attempts before the queue stops and shows the failure.
    var maxAttempts: Int
    var baseDelay: Duration
    var maxDelay: Duration
    /// Each delay is multiplied by a random factor in this range, so phones that lost the network
    /// together do not retry together.
    var jitter: ClosedRange<Double>

    /// 2 s, 4 s, 8 s, ... up to 5 minutes, about 8.5 minutes in all before the queue stops.
    static let standard = RetryPolicy(
        maxAttempts: 8,
        baseDelay: .seconds(2),
        maxDelay: .seconds(300),
        jitter: 0.8 ... 1.2,
    )

    /// The wait after failed attempt number `attempt` (1 for the first failure). A server's
    /// `retryAfterSeconds` is a minimum.
    func delay(
        afterAttempt attempt: Int,
        retryAfter: Duration? = nil,
        random: Double = .random(in: 0 ... 1),
    ) -> Duration {
        let exponent = min(max(attempt - 1, 0), 30)
        let backoff = min(baseDelay * (1 << exponent), maxDelay)
        let factor = jitter.lowerBound + (jitter.upperBound - jitter.lowerBound) * min(max(random, 0), 1)
        let jittered = backoff * factor
        guard let retryAfter else { return jittered }
        return max(jittered, retryAfter)
    }
}
