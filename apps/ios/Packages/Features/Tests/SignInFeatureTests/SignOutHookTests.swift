import APIClient
import Foundation
import SignInFeature
import Testing

/// What the app keeps on the phone for the account (the marketplace sessions) goes on every
/// sign-out, and stays when a session only ends by itself.
@MainActor
struct SignOutHookTests {
    private let harness = SignInHarness()

    private func signedIn() -> SignInModel {
        harness.tokens.signIn(AccessGrant(accessToken: "t", expiresAt: .distantFuture, email: "owner@example.com"))
        return harness.model(ScriptedSignIn())
    }

    @Test
    func `signing out runs the hook once`() {
        let model = signedIn()
        let signOuts = Count()
        model.onSignOut = { signOuts.value += 1 }

        model.signOut()

        #expect(signOuts.value == 1)
        #expect(harness.tokens.grant == nil)
    }

    @Test
    func `deleting the account's sign-out, which keeps its screen, runs it too`() {
        let model = signedIn()
        let signOuts = Count()
        model.onSignOut = { signOuts.value += 1 }

        model.signOutKeepingScreen()

        #expect(signOuts.value == 1)
        #expect(harness.tokens.grant == nil)
    }

    @Test
    func `a session that ends by itself does not run it`() async throws {
        let model = signedIn()
        let signOuts = Count()
        model.onSignOut = { signOuts.value += 1 }
        let following = Task { await model.follow() }
        defer { following.cancel() }

        // The API answered 401.
        await harness.tokens.reject("t")

        try await eventually { !model.isSignedIn }
        #expect(signOuts.value == 0)
    }
}

@MainActor
private final class Count {
    var value = 0
}
