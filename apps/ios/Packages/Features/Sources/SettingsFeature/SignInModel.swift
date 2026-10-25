import APIClient
import Foundation
import Observation

/// How this build signs in: a one-time code for an email address, from the local API's log
/// (``DevSignIn``, Dev builds) or emailed by the environment's Cognito user pool
/// (``EmailCodeSignIn``, docs/features/auth.md).
public protocol SignInMethod: Sendable {
    var kind: SignInKind { get }
    /// Sends (or, for the dev driver, logs) a code for `email`.
    func requestCode(email: String) async throws(APIFailure) -> any PendingSignIn
    /// Ends the session at its issuer too, where it can be; best effort.
    func signOut(_ grant: AccessGrant) async
}

/// A sign-in waiting for its code.
public protocol PendingSignIn: Sendable {
    func signIn(code: String) async throws(APIFailure) -> AccessGrant
}

/// What the person is told about the method, and the codes it accepts.
public enum SignInKind: Equatable, Sendable {
    /// The local API's dev driver prints a 6-digit code to its log.
    case developer
    /// Cognito emails a code of 6 to 8 digits.
    case emailCode

    var codeLengths: ClosedRange<Int> {
        switch self {
        case .developer: 6 ... 6
        case .emailCode: 6 ... 8
        }
    }
}

/// Signs in with the API's dev driver (`AUTH_DRIVER=dev`): Dev builds only.
public struct DevSignIn: SignInMethod {
    private let client: DevSignInClient

    public init(client: DevSignInClient) {
        self.client = client
    }

    public var kind: SignInKind {
        .developer
    }

    public func requestCode(email: String) async throws(APIFailure) -> any PendingSignIn {
        try await client.requestCode(email: email)
        return Pending(client: client, email: email)
    }

    public func signOut(_: AccessGrant) async {}

    private struct Pending: PendingSignIn {
        let client: DevSignInClient
        let email: String

        func signIn(code: String) async throws(APIFailure) -> AccessGrant {
            try await client.signIn(email: email, code: code)
        }
    }
}

/// Signs in with the Cognito user pool's emailed codes, and revokes the refresh token at sign-out.
public struct EmailCodeSignIn: SignInMethod {
    private let client: CognitoSignInClient

    public init(client: CognitoSignInClient) {
        self.client = client
    }

    public var kind: SignInKind {
        .emailCode
    }

    public func requestCode(email: String) async throws(APIFailure) -> any PendingSignIn {
        try await Pending(client: client, challenge: client.requestCode(email: email))
    }

    public func signOut(_ grant: AccessGrant) async {
        // Signing out on the device never waits for this: the session is already gone here, and
        // a refresh token that could not be revoked expires within 30 days.
        try? await client.revoke(grant)
    }

    private struct Pending: PendingSignIn {
        let client: CognitoSignInClient
        let challenge: CognitoSignInClient.Challenge

        func signIn(code: String) async throws(APIFailure) -> AccessGrant {
            try await client.signIn(challenge, code: code)
        }
    }
}

/// Signing in from Settings: enter the email, request a code, and enter it. Without a method, the
/// build cannot sign in at all (a Staging or Prod build whose xcconfig has no Cognito app client).
@MainActor
@Observable
public final class SignInModel {
    public enum Stage: Equatable {
        case unavailable
        case enterEmail
        case enterCode
        case signedIn(email: String)
    }

    public var email = ""
    public var code = ""
    public private(set) var stage: Stage
    public private(set) var isWorking = false
    /// The last failure, safe to show.
    public private(set) var message: String?

    public let kind: SignInKind?
    private let method: (any SignInMethod)?
    private let tokens: AccessTokenStore
    private var pending: (any PendingSignIn)?

    public init(method: (any SignInMethod)?, tokens: AccessTokenStore) {
        self.method = method
        self.tokens = tokens
        kind = method?.kind
        stage = Self.stage(method: method, grant: tokens.grant)
    }

    public var canRequestCode: Bool {
        !isWorking && email.contains("@")
    }

    public var canSignIn: Bool {
        guard let kind, !isWorking else { return false }
        return kind.codeLengths.contains(code.count) && code.allSatisfy(\.isNumber)
    }

    public func requestCode() async {
        guard let method else { return }
        let email = email.trimmingCharacters(in: .whitespaces).lowercased()
        await run { () throws(APIFailure) in
            self.pending = try await method.requestCode(email: email)
            self.email = email
            self.code = ""
            self.stage = .enterCode
        }
    }

    public func signIn() async {
        guard let pending else { return }
        let code = code.trimmingCharacters(in: .whitespaces)
        await run { () throws(APIFailure) in
            let grant = try await pending.signIn(code: code)
            self.tokens.signIn(grant)
            self.pending = nil
            self.stage = .signedIn(email: grant.email)
        }
    }

    /// Back to the email: a different address, or a new code after this one ended.
    public func startOver() {
        pending = nil
        code = ""
        message = nil
        if method != nil {
            stage = .enterEmail
        }
    }

    public func signOut() {
        if let grant = tokens.grant, let method {
            Task { await method.signOut(grant) }
        }
        tokens.signOut()
        startOver()
    }

    /// The session ends when it can no longer be renewed or the API rejects it; Settings shows
    /// that on appearing.
    public func refresh() {
        if case .signedIn = stage, tokens.grant == nil {
            stage = Self.stage(method: method, grant: nil)
        }
    }

    private static func stage(method: (any SignInMethod)?, grant: AccessGrant?) -> Stage {
        if let grant {
            return .signedIn(email: grant.email)
        }
        return method == nil ? .unavailable : .enterEmail
    }

    private func run(_ work: @escaping @MainActor () async throws(APIFailure) -> Void) async {
        isWorking = true
        message = nil
        defer { isWorking = false }
        do {
            try await work()
        } catch {
            message = error.message
        }
    }
}
