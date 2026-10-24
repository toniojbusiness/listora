import APIClient
import Foundation
import Observation

/// Developer sign-in against the local API (`AUTH_DRIVER=dev`): request a code, read it from the
/// API's log, and enter it. Dev builds only; production sign-in arrives with Cognito (T-31).
@MainActor
@Observable
public final class DevSignInModel {
    public enum Stage: Equatable {
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

    private let client: DevSignInClient
    private let tokens: AccessTokenStore

    public init(client: DevSignInClient, tokens: AccessTokenStore) {
        self.client = client
        self.tokens = tokens
        stage = tokens.grant.map { .signedIn(email: $0.email) } ?? .enterEmail
    }

    public var canRequestCode: Bool {
        !isWorking && email.contains("@")
    }

    public var canSignIn: Bool {
        !isWorking && code.count == 6
    }

    public func requestCode() async {
        let email = email.trimmingCharacters(in: .whitespaces).lowercased()
        await run { () throws(APIFailure) in
            try await self.client.requestCode(email: email)
            self.email = email
            self.code = ""
            self.stage = .enterCode
        }
    }

    public func signIn() async {
        let email = email
        let code = code
        await run { () throws(APIFailure) in
            let grant = try await self.client.signIn(email: email, code: code)
            self.tokens.signIn(grant)
            self.stage = .signedIn(email: grant.email)
        }
    }

    public func signOut() {
        tokens.signOut()
        code = ""
        message = nil
        stage = .enterEmail
    }

    /// The session ends when it expires or the API rejects it; Settings shows that on appearing.
    public func refresh() {
        if case .signedIn = stage, tokens.grant == nil {
            stage = .enterEmail
        }
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
