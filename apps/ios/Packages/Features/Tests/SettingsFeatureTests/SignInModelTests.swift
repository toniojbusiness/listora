import APIClient
import Foundation
import SettingsFeature
import Synchronization
import Testing

/// A sign-in method that answers from a script and records what it was asked.
private final class ScriptedSignIn: SignInMethod {
    let kind: SignInKind
    let requested = Mutex<[String]>([])
    let signedOut = Mutex<[AccessGrant]>([])
    private let codeFailure: APIFailure?
    private let requestFailure: APIFailure?

    init(kind: SignInKind = .emailCode, requestFailure: APIFailure? = nil, codeFailure: APIFailure? = nil) {
        self.kind = kind
        self.requestFailure = requestFailure
        self.codeFailure = codeFailure
    }

    func requestCode(email: String) async throws(APIFailure) -> any PendingSignIn {
        requested.withLock { $0.append(email) }
        if let requestFailure {
            throw requestFailure
        }
        return Pending(email: email, failure: codeFailure)
    }

    func signOut(_ grant: AccessGrant) async {
        signedOut.withLock { $0.append(grant) }
    }

    private struct Pending: PendingSignIn {
        let email: String
        let failure: APIFailure?

        func signIn(code: String) async throws(APIFailure) -> AccessGrant {
            if let failure {
                throw failure
            }
            return AccessGrant(
                accessToken: "id-\(code)", expiresAt: .distantFuture, email: email, refreshToken: "refresh",
            )
        }
    }
}

@MainActor
struct SignInModelTests {
    private let tokens = AccessTokenStore(storage: InMemoryAccessGrantStorage())

    @Test
    func `signs in with an emailed code and keeps the session`() async {
        let method = ScriptedSignIn()
        let model = SignInModel(method: method, tokens: tokens)
        #expect(model.stage == .enterEmail)

        model.email = " Owner@Example.com "
        await model.requestCode()
        #expect(model.stage == .enterCode)
        #expect(method.requested.withLock { $0 } == ["owner@example.com"])

        model.code = "12345678"
        #expect(model.canSignIn)
        await model.signIn()

        #expect(model.stage == .signedIn(email: "owner@example.com"))
        #expect(tokens.grant?.accessToken == "id-12345678")
        #expect(model.message == nil)
    }

    @Test
    func `accepts a 6 to 8 digit emailed code, and only a 6 digit developer code`() {
        let email = SignInModel(method: ScriptedSignIn(kind: .emailCode), tokens: tokens)
        let developer = SignInModel(method: ScriptedSignIn(kind: .developer), tokens: tokens)
        for (code, emailed, logged) in [
            ("12345", false, false), ("123456", true, true), ("12345678", true, false),
            ("123456789", false, false), ("12345a", false, false),
        ] {
            email.code = code
            developer.code = code
            #expect(email.canSignIn == emailed, "\(code)")
            #expect(developer.canSignIn == logged, "\(code)")
        }
    }

    @Test
    func `shows a wrong code's message and keeps the code step for another try`() async {
        let wrong = APIFailure(
            statusCode: 400,
            code: "invalid_code",
            message: "That code isn't right.",
            retryable: false,
        )
        let model = SignInModel(method: ScriptedSignIn(codeFailure: wrong), tokens: tokens)
        model.email = "owner@example.com"
        await model.requestCode()
        model.code = "000000"

        await model.signIn()

        #expect(model.stage == .enterCode)
        #expect(model.message == "That code isn't right.")
        #expect(tokens.grant == nil)
    }

    @Test
    func `shows why no code was sent and stays on the email`() async {
        let model = SignInModel(method: ScriptedSignIn(requestFailure: .networkUnavailable), tokens: tokens)
        model.email = "owner@example.com"

        await model.requestCode()

        #expect(model.stage == .enterEmail)
        #expect(model.message == APIFailure.networkUnavailable.message)
    }

    @Test
    func `signing out ends the session here and at its issuer`() async throws {
        let method = ScriptedSignIn()
        let model = SignInModel(method: method, tokens: tokens)
        model.email = "owner@example.com"
        await model.requestCode()
        model.code = "123456"
        await model.signIn()
        let grant = try #require(tokens.grant)

        model.signOut()

        #expect(model.stage == .enterEmail)
        #expect(tokens.grant == nil)
        for _ in 0 ..< 100 where method.signedOut.withLock({ $0.isEmpty }) {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(method.signedOut.withLock { $0 } == [grant])
    }

    @Test
    func `a build without a sign-in method says it cannot sign in`() {
        let model = SignInModel(method: nil, tokens: tokens)
        #expect(model.stage == .unavailable)
        #expect(model.kind == nil)
        model.startOver()
        #expect(model.stage == .unavailable)
    }

    @Test
    func `starts signed in with a kept session, and notices when it ends`() {
        tokens.signIn(AccessGrant(accessToken: "t", expiresAt: .distantFuture, email: "owner@example.com"))
        let model = SignInModel(method: ScriptedSignIn(), tokens: tokens)
        #expect(model.stage == .signedIn(email: "owner@example.com"))

        tokens.signOut()
        model.refresh()

        #expect(model.stage == .enterEmail)
    }
}
