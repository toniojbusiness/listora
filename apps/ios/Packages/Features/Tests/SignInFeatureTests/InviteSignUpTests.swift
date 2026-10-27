import APIClient
import Foundation
import SignInFeature
import Synchronization
import Testing

/// Signing up with an invite: the code and the person's own email, then the usual emailed code.
@MainActor
struct InviteSignUpTests {
    /// Answers each redemption from a script and records what it was asked.
    private final class ScriptedRedeemer: InviteRedeemer {
        let redeemed = Mutex<[String]>([])
        let answers: Mutex<[Result<InviteRedemption, APIFailure>]>

        init(_ answers: [Result<InviteRedemption, APIFailure>]) {
            self.answers = Mutex(answers)
        }

        func redeem(code: String, email: String) async throws(APIFailure) -> InviteRedemption {
            redeemed.withLock { $0.append("\(code) \(email)") }
            let answer = answers.withLock { $0.isEmpty ? nil : $0.removeFirst() }
            guard let answer else { throw failure(500, "internal_error") }
            return try answer.get()
        }
    }

    private static let code = "K7QD-3M9P-XW2T-H8RA"
    private static let ready = InviteRedemption(
        email: "maria@example.com", isReady: true, message: "Sign in with maria@example.com.",
    )
    private static let waiting = InviteRedemption(
        email: "maria@example.com", isReady: false, message: "Open the link Amazon Web Services emailed you.",
    )

    private let harness = SignInHarness()

    private func model(
        _ redeemer: ScriptedRedeemer,
        method: ScriptedSignIn = ScriptedSignIn(),
    ) -> (SignInModel, InviteSignUpModel) {
        let clock = harness.clock
        let signIn = SignInModel(method: method, tokens: harness.tokens, inviteRedeemer: redeemer, now: { clock.now })
        signIn.openInvite(code: Self.code)
        guard let invite = signIn.invite else {
            Issue.record("a build that signs in offers the invite sign-up")
            return (signIn, InviteSignUpModel(redeemer: redeemer) { _ in })
        }
        invite.email = " Maria@Example.com "
        return (signIn, invite)
    }

    @Test
    func `redeems the invite, then signs in with the code emailed to that address`() async {
        let redeemer = ScriptedRedeemer([.success(Self.ready)])
        let method = ScriptedSignIn()
        let (signIn, invite) = model(redeemer, method: method)
        #expect(signIn.showsInvite)
        #expect(invite.code == Self.code)
        #expect(invite.canRedeem)

        await invite.redeem()

        #expect(redeemer.redeemed.withLock { $0 } == ["\(Self.code) maria@example.com"])
        #expect(method.requested.withLock { $0 } == ["maria@example.com"])
        #expect(signIn.stage == .enterCode)
        #expect(signIn.email == "maria@example.com")
        #expect(invite.problem == nil)

        signIn.enterCode("12345678")
        await signIn.signIn()
        #expect(signIn.stage == .signedIn(email: "maria@example.com"))
        #expect(!signIn.showsInvite)
    }

    @Test
    func `waits for the address's verification link, then carries on`() async {
        let redeemer = ScriptedRedeemer([.success(Self.waiting), .success(Self.ready)])
        let method = ScriptedSignIn()
        let (signIn, invite) = model(redeemer, method: method)

        await invite.redeem()
        #expect(invite.verification == Self.waiting.message)
        #expect(method.requested.withLock { $0 }.isEmpty)
        #expect(signIn.stage == .enterEmail)

        await invite.redeem()
        #expect(invite.verification == nil)
        #expect(signIn.stage == .enterCode)
    }

    @Test
    func `shows why a code did not work, and asks for no sign-in code`() async {
        let refusal = failure(409, "invalid_state_transition", "This invite has expired. Ask for a new one.")
        let redeemer = ScriptedRedeemer([.failure(refusal), .failure(.networkUnavailable)])
        let method = ScriptedSignIn()
        let (signIn, invite) = model(redeemer, method: method)

        await invite.redeem()
        #expect(invite.problem == "This invite has expired. Ask for a new one.")
        await invite.redeem()
        #expect(invite.problem == "Can't reach Listora. Check your connection, then try again.")
        #expect(method.requested.withLock { $0 }.isEmpty)
        #expect(signIn.stage == .enterEmail)
        #expect(!invite.isWorking)
    }

    @Test
    func `continues only with a whole code and email`() {
        let (_, invite) = model(ScriptedRedeemer([]))
        for (code, email, ready) in [
            (Self.code, "maria@example.com", true),
            ("k7qd 3m9p xw2t h8ra", "maria@example.com", true),
            ("K7QD-3M9P-XW2T", "maria@example.com", false),
            (Self.code, "maria@", false),
        ] {
            invite.code = code
            invite.email = email
            #expect(invite.canRedeem == ready, "\(code) \(email)")
        }
    }

    @Test
    func `a signed-in person does not get the sign-up`() async {
        let signIn = await harness.atCodeStep()
        signIn.enterCode("12345678")
        await signIn.signIn()
        let withInvites = SignInModel(
            method: ScriptedSignIn(), tokens: harness.tokens, inviteRedeemer: ScriptedRedeemer([]),
        )
        withInvites.openInvite(code: Self.code)
        #expect(!withInvites.showsInvite)
    }

    @Test
    func `a build that cannot sign in offers no sign-up`() {
        let signIn = SignInModel(method: nil, tokens: harness.tokens, inviteRedeemer: ScriptedRedeemer([]))
        #expect(signIn.invite == nil)
        signIn.openInvite(code: Self.code)
        #expect(!signIn.showsInvite)
    }

    @Test
    func `reads the code from an invite link`() throws {
        #expect(try InviteLink.code(in: #require(URL(string: "listora://invite/\(Self.code)"))) == Self.code)
        #expect(try InviteLink
            .code(in: #require(URL(string: "LISTORA://Invite/K7QD3M9PXW2TH8RA"))) == "K7QD3M9PXW2TH8RA")
        for link in [
            "listora://invite/",
            "listora://invite/K7QD",
            "listora://connections/ebay",
            "https://listora.app/invite/\(Self.code)",
        ] {
            #expect(try InviteLink.code(in: #require(URL(string: link))) == nil, "\(link)")
        }
    }
}
