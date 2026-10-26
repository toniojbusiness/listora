import APIClient
import Foundation

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

    public var codeLengths: ClosedRange<Int> {
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
