import APIClient
import Foundation
import SignInFeature
import Testing

/// The email and code steps, and what each failure tells the person.
@MainActor
struct SignInModelTests {
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

    // MARK: Email

    @Test
    func `signs in with an emailed code and keeps the session`() async {
        let method = ScriptedSignIn()
        let model = model(method)
        #expect(model.stage == .enterEmail)
        #expect(!model.isSignedIn)

        model.email = " Owner@Example.com "
        await model.requestCode()
        #expect(model.stage == .enterCode)
        #expect(model.email == "owner@example.com")
        #expect(method.requested.withLock { $0 } == ["owner@example.com"])

        model.enterCode("12345678")
        #expect(model.canSignIn)
        await model.signIn()

        #expect(model.stage == .signedIn(email: "owner@example.com"))
        #expect(model.isSignedIn)
        #expect(tokens.grant?.accessToken == "id-12345678")
        #expect(model.problem == nil)
    }

    @Test
    func `continues only with a whole email address`() {
        let model = model()
        for (email, plausible) in [
            ("", false), ("owner", false), ("owner@", false), ("@example.com", false), ("owner@example", false),
            ("owner@example.", false), ("own er@example.com", false), ("owner@example.com", true),
            (" owner@example.co.uk ", true),
        ] {
            model.email = email
            #expect(model.canRequestCode == plausible, "\(email)")
        }
    }

    @Test
    func `shows that it cannot reach Listora and stays on the email`() async {
        let model = model(ScriptedSignIn(requestFailure: .networkUnavailable))
        model.email = "owner@example.com"

        await model.requestCode()

        #expect(model.stage == .enterEmail)
        #expect(model.problem?.kind == .offline)
        #expect(model.problem?.message == "Can't reach Listora. Check your connection, then try again.")
        #expect(!model.isWorking)
    }

    @Test(arguments: [
        failure(401, "unauthenticated"),
        failure(nil, "sign_in_unavailable"),
        failure(403, "forbidden"),
    ])
    func `says an email that is not allowed cannot sign in`(refusal: APIFailure) async {
        let model = model(ScriptedSignIn(requestFailure: refusal))
        model.email = "stranger@example.com"

        await model.requestCode()

        #expect(model.stage == .enterEmail)
        #expect(model.problem?.kind == .emailNotAllowed)
        #expect(model.problem?.message.hasPrefix("This email can't sign in to Listora.") == true)
    }

    @Test
    func `passes on a rate limit in the server's words`() async {
        let model = model(ScriptedSignIn(requestFailure: failure(
            429,
            "rate_limited",
            "Too many tries. Wait a minute.",
        )))
        model.email = "owner@example.com"

        await model.requestCode()

        #expect(model.problem == .init(kind: .rateLimited, message: "Too many tries. Wait a minute."))
    }

    // MARK: Code

    @Test
    func `accepts a 6 to 8 digit emailed code, and only a 6 digit developer code`() async {
        let email = await atCodeStep(ScriptedSignIn(kind: .emailCode))
        let developer = await atCodeStep(ScriptedSignIn(kind: .developer))
        // The developer field keeps 6 digits of an 8-digit entry, which is then a whole code.
        for (code, emailed, logged) in [
            ("12345", false, false), ("123456", true, true), ("1234567", true, true), ("12345678", true, true),
        ] {
            email.enterCode(code)
            developer.enterCode(code)
            #expect(email.canSignIn == emailed, "\(code)")
            #expect(developer.canSignIn == logged, "\(code)")
        }
    }

    @Test
    func `keeps only the digits of what is typed or pasted, up to the longest code`() async {
        let model = await atCodeStep(ScriptedSignIn(kind: .developer))
        model.enterCode("12a3")
        #expect(model.code == "123")
        model.enterCode("Your Listora code is 654 321. It works for 10 minutes.")
        #expect(model.code == "654321")
        model.enterCode("١٢٣٤٥٦")
        #expect(model.code.isEmpty, "only ASCII digits are a code")
    }

    @Test
    func `signs in on its own when a whole code is pasted or autofilled, not while typing`() async {
        let model = await atCodeStep(ScriptedSignIn(kind: .developer))
        for digit in "12345" {
            #expect(!model.enterCode(model.code + String(digit)))
        }
        // The sixth typed digit completes the code, but the person taps Sign in.
        #expect(!model.enterCode("123456"))

        model.enterCode("")
        #expect(model.enterCode("123456"), "a pasted code submits itself")
        #expect(!model.enterCode("12"), "a partial paste waits for the rest")
    }

    @Test
    func `says a wrong code is wrong, clears it, and stays on the code step`() async {
        let model = await atCodeStep(ScriptedSignIn(codeFailure: failure(400, "invalid_code")))
        model.enterCode("000000")

        await model.signIn()

        #expect(model.stage == .enterCode)
        #expect(model.problem == .init(
            kind: .wrongCode,
            message: "That code isn't right. Check the email and try again.",
        ))
        #expect(model.code.isEmpty)
        #expect(tokens.grant == nil)

        model.enterCode("1")
        #expect(model.problem == nil, "typing a new code clears the error")
    }

    @Test
    func `shows the dev driver's own words for a code it refuses`() async {
        let refused = failure(401, "unauthenticated", "That sign-in code is not correct.")
        let model = await atCodeStep(ScriptedSignIn(kind: .developer, codeFailure: refused))
        model.enterCode("000000")

        await model.signIn()

        #expect(model.problem == .init(kind: .wrongCode, message: "That sign-in code is not correct."))
        #expect(model.stage == .enterCode)
    }

    @Test
    func `says an expired code needs a new one`() async {
        let model = await atCodeStep(ScriptedSignIn(codeFailure: failure(400, "code_expired")))
        model.enterCode("12345678")

        await model.signIn()

        #expect(model.problem == .init(kind: .codeExpired, message: "That code has expired. Send a new code."))
        #expect(model.code.isEmpty)
        #expect(model.stage == .enterCode)
    }

    @Test
    func `keeps the code when the network fails, so Try again sends it`() async {
        let model = await atCodeStep(ScriptedSignIn(codeFailure: .networkUnavailable))
        model.enterCode("12345678")

        await model.signIn()

        #expect(model.problem?.kind == .offline)
        #expect(model.code == "12345678")
        #expect(model.canSignIn)
    }

    @Test
    func `sends a new code only after the cooldown`() async {
        let method = ScriptedSignIn()
        let model = await atCodeStep(method)
        #expect(model.resendWait(at: clock.now) == 30)

        clock.advance(by: 12.5)
        #expect(model.resendWait(at: clock.now) == 18)
        await model.resendCode()
        #expect(method.requested.withLock { $0.count } == 1, "too early")

        clock.advance(by: 17.5)
        #expect(model.resendWait(at: clock.now) == 0)
        model.enterCode("12")
        await model.resendCode()
        #expect(method.requested.withLock { $0 } == ["owner@example.com", "owner@example.com"])
        #expect(model.code.isEmpty)
        #expect(model.resendWait(at: clock.now) == 30, "the new code restarts the cooldown")
    }

    @Test
    func `goes back to the email for a different address`() async {
        let model = await atCodeStep()
        model.enterCode("12")

        model.startOver()

        #expect(model.stage == .enterEmail)
        #expect(model.code.isEmpty)
        #expect(model.resendWait(at: clock.now) == 0)
        await model.signIn()
        #expect(tokens.grant == nil, "the abandoned sign-in cannot finish")
    }
}
