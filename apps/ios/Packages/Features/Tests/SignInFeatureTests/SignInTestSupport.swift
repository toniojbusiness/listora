import APIClient
import Foundation
import SignInFeature
import Synchronization
import Testing

// Test support for the sign-in model.

/// A sign-in method that answers from a script and records what it was asked.
final class ScriptedSignIn: SignInMethod {
    let kind: SignInKind
    let requested = Mutex<[String]>([])
    let signedOut = Mutex<[AccessGrant]>([])
    private let codeFailure: APIFailure?
    private let requestFailure: APIFailure?
    private let expiresAt: Date
    private let refreshToken: String?

    init(
        kind: SignInKind = .emailCode,
        requestFailure: APIFailure? = nil,
        codeFailure: APIFailure? = nil,
        expiresAt: Date = .distantFuture,
        refreshToken: String? = "refresh",
    ) {
        self.kind = kind
        self.requestFailure = requestFailure
        self.codeFailure = codeFailure
        self.expiresAt = expiresAt
        self.refreshToken = refreshToken
    }

    func requestCode(email: String) async throws(APIFailure) -> any PendingSignIn {
        requested.withLock { $0.append(email) }
        if let requestFailure {
            throw requestFailure
        }
        return Pending(email: email, failure: codeFailure, expiresAt: expiresAt, refreshToken: refreshToken)
    }

    func signOut(_ grant: AccessGrant) async {
        signedOut.withLock { $0.append(grant) }
    }

    private struct Pending: PendingSignIn {
        let email: String
        let failure: APIFailure?
        let expiresAt: Date
        let refreshToken: String?

        func signIn(code: String) async throws(APIFailure) -> AccessGrant {
            if let failure {
                throw failure
            }
            return AccessGrant(
                accessToken: "id-\(code)", expiresAt: expiresAt, email: email, refreshToken: refreshToken,
            )
        }
    }
}

/// A clock the test moves.
final class TestClock: Sendable {
    private let date = Mutex(Date(timeIntervalSince1970: 1_800_000_000))

    var now: Date {
        date.withLock { $0 }
    }

    func advance(by seconds: TimeInterval) {
        date.withLock { $0 = $0.addingTimeInterval(seconds) }
    }
}

func failure(_ status: Int?, _ code: String, _ message: String = "Server says no.") -> APIFailure {
    APIFailure(statusCode: status, code: code, message: message, retryable: false)
}

/// A model with its own session and clock.
@MainActor
struct SignInHarness {
    let clock = TestClock()
    let tokens: AccessTokenStore

    init() {
        let clock = clock
        tokens = AccessTokenStore(storage: InMemoryAccessGrantStorage(), now: { clock.now })
    }

    func model(_ method: ScriptedSignIn? = ScriptedSignIn()) -> SignInModel {
        let clock = clock
        return SignInModel(method: method, tokens: tokens, now: { clock.now })
    }

    /// A model on the code step for owner@example.com.
    func atCodeStep(_ method: ScriptedSignIn = ScriptedSignIn()) async -> SignInModel {
        let model = model(method)
        model.email = "owner@example.com"
        await model.requestCode()
        return model
    }
}

/// Waits up to 2 seconds for `condition`, which work on another task makes true.
@MainActor
func eventually(_ condition: () -> Bool) async throws {
    var tries = 0
    while !condition(), tries < 200 {
        tries += 1
        try await Task.sleep(for: .milliseconds(10))
    }
}
