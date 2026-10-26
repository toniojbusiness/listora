import APIClient
import Foundation
import SignInFeature
import Testing

/// Following the session: signing out, and a session that ends or starts elsewhere.
@MainActor
struct SignInSessionTests {
    private let harness = SignInHarness()

    private var clock: TestClock {
        harness.clock
    }

    private var tokens: AccessTokenStore {
        harness.tokens
    }

    private func model(_ method: ScriptedSignIn? = ScriptedSignIn()) -> SignInModel {
        harness.model(method)
    }

    private func atCodeStep(_ method: ScriptedSignIn = ScriptedSignIn()) async -> SignInModel {
        await harness.atCodeStep(method)
    }

    @Test
    func `signing out ends the session here and at its issuer, without a notice`() async throws {
        let method = ScriptedSignIn()
        let model = await atCodeStep(method)
        model.enterCode("123456")
        await model.signIn()
        let grant = try #require(tokens.grant)

        model.signOut()

        #expect(model.stage == .enterEmail)
        #expect(model.notice == nil)
        #expect(tokens.grant == nil)
        try await eventually { !method.signedOut.withLock { $0.isEmpty } }
        #expect(method.signedOut.withLock { $0 } == [grant])
    }

    @Test
    func `a build without a sign-in method says it cannot sign in`() {
        let model = model(nil)
        #expect(model.stage == .unavailable)
        #expect(model.kind == nil)
        model.startOver()
        #expect(model.stage == .unavailable)
    }

    @Test
    func `returns to the sign-in with a notice when the session ends elsewhere`() async throws {
        tokens.signIn(AccessGrant(accessToken: "t", expiresAt: .distantFuture, email: "owner@example.com"))
        let model = model()
        #expect(model.stage == .signedIn(email: "owner@example.com"))
        let following = Task { await model.follow() }
        defer { following.cancel() }

        // The API answered 401.
        await tokens.reject("t")

        try await eventually { !model.isSignedIn }
        #expect(model.stage == .enterEmail)
        #expect(model.notice == SignInModel.sessionEnded)
        #expect(model.email == "owner@example.com", "the email is kept for signing in again")
    }

    @Test
    func `shows the app when a session starts elsewhere`() async throws {
        let model = model()
        let following = Task { await model.follow() }
        defer { following.cancel() }

        tokens.signIn(AccessGrant(accessToken: "t", expiresAt: .distantFuture, email: "owner@example.com"))

        try await eventually { model.isSignedIn }
        #expect(model.stage == .signedIn(email: "owner@example.com"))
    }

    @Test
    func `notices a session that expired while the app was away`() async {
        let model = await atCodeStep(ScriptedSignIn(expiresAt: clock.now.addingTimeInterval(60), refreshToken: nil))
        model.enterCode("123456")
        await model.signIn()
        #expect(model.isSignedIn)

        clock.advance(by: 61)
        model.refresh()

        #expect(model.stage == .enterEmail)
        #expect(model.notice == SignInModel.sessionEnded)
    }

    @Test
    func `a signed-out screen's Sign in ends what is left of the session`() {
        tokens.signIn(AccessGrant(accessToken: "t", expiresAt: .distantFuture, email: "owner@example.com"))
        let model = model()

        model.showSignIn()

        #expect(model.stage == .enterEmail)
        #expect(tokens.grant == nil)
    }

    @Test
    func `a new sign-in clears the notice of the session that ended`() async {
        tokens.signIn(AccessGrant(accessToken: "t", expiresAt: .distantFuture, email: "owner@example.com"))
        let model = model()
        tokens.signOut()
        model.refresh()
        #expect(model.notice != nil)

        await model.requestCode()
        model.enterCode("123456")
        await model.signIn()

        #expect(model.isSignedIn)
        #expect(model.notice == nil)
    }

    @Test
    func `deleting the account keeps its result on screen until the person leaves it`() async throws {
        let method = ScriptedSignIn()
        tokens.signIn(AccessGrant(accessToken: "t", expiresAt: .distantFuture, email: "owner@example.com"))
        let model = model(method)
        let following = Task { await model.follow() }
        defer { following.cancel() }

        model.signOutKeepingScreen()

        #expect(tokens.grant == nil, "the session ends at once")
        try await eventually { !method.signedOut.withLock { $0.isEmpty } }
        model.refresh()
        #expect(model.isSignedIn, "the app stays on screen")

        model.finishSignOut()

        #expect(model.stage == .enterEmail)
        #expect(model.notice == nil, "not a session that ended by itself")
        #expect(model.email.isEmpty, "the deleted account's email is not kept")
        model.finishSignOut()
        #expect(model.stage == .enterEmail)
    }
}
