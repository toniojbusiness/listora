import APIClient
import Foundation
import Observation

/// Why the last step did not work, in words the person can act on.
public struct SignInProblem: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// The code does not match; another try may work.
        case wrongCode
        /// The code (or the sign-in it belongs to) has ended: only a new code works.
        case codeExpired
        /// This address cannot sign in to Listora.
        case emailNotAllowed
        /// No connection to Listora (or to the user pool).
        case offline
        /// Too many tries for now.
        case rateLimited
        /// Anything else, in the server's words.
        case other
    }

    public let kind: Kind
    public let message: String

    public init(kind: Kind, message: String) {
        self.kind = kind
        self.message = message
    }
}

/// The session and the way into it: enter the email, request a code, and enter it. The app shows
/// the sign-in screens as its root while ``stage`` is not ``Stage/signedIn(email:)``, so it
/// follows the session (``follow()``) and returns to them when it ends: signing out, the API
/// rejecting the token, a refresh Cognito refuses, or a session that simply expires. Without a
/// method, the build cannot sign in at all (a Staging or Prod build whose xcconfig has no Cognito
/// app client).
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
    /// The code as typed, digits only; change it with ``enterCode(_:)``.
    public private(set) var code = ""
    public private(set) var stage: Stage
    public private(set) var isWorking = false
    public private(set) var problem: SignInProblem?
    /// Why the person is signed out, when it was not their own doing.
    public private(set) var notice: String?
    /// When the last code was sent, which starts the resend cooldown.
    public private(set) var codeSentAt: Date?

    public let kind: SignInKind?
    /// Signing up with an invite; nil when this build cannot (it has no way to sign in).
    public private(set) var invite: InviteSignUpModel?
    /// The invite sign-up screen is open over the welcome screen.
    public var showsInvite = false
    private let method: (any SignInMethod)?
    private let tokens: AccessTokenStore
    private let now: @Sendable () -> Date
    private var pending: (any PendingSignIn)?
    private var expiry: Task<Void, Never>?
    /// The session has ended, but the screen that ended it stays until ``finishSignOut()``.
    private var holdsScreen = false

    /// A new code can be requested this long after the last one.
    public static let resendCooldown: TimeInterval = 30
    public static let sessionEnded = "Your session has ended. Sign in again to pick up where you left off."

    public init(
        method: (any SignInMethod)?,
        tokens: AccessTokenStore,
        inviteRedeemer: (any InviteRedeemer)? = nil,
        now: @escaping @Sendable () -> Date = Date.init,
    ) {
        self.method = method
        self.tokens = tokens
        self.now = now
        kind = method?.kind
        stage = Self.stage(method: method, grant: tokens.grant)
        if let inviteRedeemer, method != nil {
            invite = InviteSignUpModel(redeemer: inviteRedeemer) { [weak self] email in
                await self?.signUp(email: email)
            }
        }
    }

    public var isSignedIn: Bool {
        if case .signedIn = stage {
            true
        } else {
            false
        }
    }

    public var canRequestCode: Bool {
        !isWorking && Self.isPlausibleEmail(email)
    }

    public var canSignIn: Bool {
        guard let kind, !isWorking else { return false }
        return kind.codeLengths.contains(code.count)
    }

    /// Whole seconds until a new code can be requested; 0 when it can.
    public func resendWait(at date: Date) -> Int {
        guard let codeSentAt else { return 0 }
        let remaining = codeSentAt.addingTimeInterval(Self.resendCooldown).timeIntervalSince(date)
        return max(0, Int(remaining.rounded(.up)))
    }

    public func requestCode() async {
        guard let method, Self.isPlausibleEmail(email) else { return }
        let email = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        await run(codeStep: false) { () throws(APIFailure) in
            self.pending = try await method.requestCode(email: email)
            self.email = email
            self.code = ""
            self.codeSentAt = self.now()
            self.notice = nil
            self.stage = .enterCode
        }
    }

    /// Sends a new code to the same address, once the cooldown has passed.
    public func resendCode() async {
        guard stage == .enterCode, resendWait(at: now()) == 0 else { return }
        await requestCode()
    }

    /// Takes typed, pasted, or autofilled text as the code: digits only, at most the longest code.
    /// Returns true when a whole code arrived at once (a paste or the keyboard's autofill), which
    /// the screen then submits without a tap.
    @discardableResult
    public func enterCode(_ text: String) -> Bool {
        guard let kind else { return false }
        let digits = String(text.filter(\.isASCIIDigit).prefix(kind.codeLengths.upperBound))
        let arrivedAtOnce = digits.count - code.count > 1
        code = digits
        if problem?.kind == .wrongCode {
            problem = nil
        }
        return arrivedAtOnce && canSignIn
    }

    public func signIn() async {
        guard let pending, canSignIn else { return }
        let code = code
        await run(codeStep: true) { () throws(APIFailure) in
            let grant = try await pending.signIn(code: code)
            self.pending = nil
            self.code = ""
            self.codeSentAt = nil
            self.stage = .signedIn(email: grant.email)
            self.tokens.signIn(grant)
        }
    }

    /// Back to the email: a different address.
    public func startOver() {
        pending = nil
        code = ""
        problem = nil
        codeSentAt = nil
        if method != nil {
            stage = .enterEmail
        }
    }

    public func signOut() {
        if let grant = tokens.grant, let method {
            Task { await method.signOut(grant) }
        }
        notice = nil
        stage = Self.stage(method: method, grant: nil)
        tokens.signOut()
        startOver()
    }

    /// Ends the session now but keeps the app on screen until ``finishSignOut()``: deleting the
    /// account signs out, and its result (the marketplaces to revoke by hand) must stay readable.
    public func signOutKeepingScreen() {
        holdsScreen = true
        if let grant = tokens.grant, let method {
            Task { await method.signOut(grant) }
        }
        tokens.signOut()
    }

    /// Shows the sign-in after ``signOutKeepingScreen()``, once the person leaves that screen.
    public func finishSignOut() {
        guard holdsScreen else { return }
        holdsScreen = false
        email = ""
        notice = nil
        startOver()
        stage = Self.stage(method: method, grant: nil)
    }

    /// A screen that found itself signed out (its server answered `401`) sends the person here:
    /// whatever is left of the session goes, and the sign-in screens take over.
    public func showSignIn() {
        if holdsScreen {
            finishSignOut()
        } else if tokens.grant != nil {
            signOut()
        } else if isSignedIn {
            endSession()
        }
    }

    /// Follows the session for as long as the caller runs: a session that ends anywhere (the API's
    /// `401`, a refresh the user pool refuses) shows the sign-in screens, and one that starts
    /// elsewhere shows the app.
    public func follow() async {
        for await grant in tokens.changes() {
            apply(grant)
        }
        expiry?.cancel()
    }

    /// Checks the session again, for an expiry no change announced (on returning to the app).
    public func refresh() {
        apply(tokens.grant)
    }

    private func apply(_ grant: AccessGrant?) {
        expiry?.cancel()
        expiry = nil
        guard let grant else {
            if isSignedIn, !holdsScreen {
                endSession()
            }
            return
        }
        if !isSignedIn {
            pending = nil
            code = ""
            problem = nil
            notice = nil
            showsInvite = false
        }
        stage = .signedIn(email: grant.email)
        // A session without a refresh token (the dev driver's) just ends: nothing announces it.
        if grant.refreshToken == nil {
            let remaining = grant.expiresAt.timeIntervalSince(now())
            expiry = Task { [weak self] in
                try? await Task.sleep(for: .seconds(max(0, remaining)))
                guard !Task.isCancelled else { return }
                self?.refresh()
            }
        }
    }

    /// The session ended without the person signing out: back to the sign-in, with the email kept.
    private func endSession() {
        if case let .signedIn(email) = stage {
            self.email = email
        }
        notice = Self.sessionEnded
        startOver()
        stage = Self.stage(method: method, grant: nil)
    }

    private static func stage(method: (any SignInMethod)?, grant: AccessGrant?) -> Stage {
        if let grant {
            return .signedIn(email: grant.email)
        }
        return method == nil ? .unavailable : .enterEmail
    }

    /// One `@` with something on both sides and a dot in the domain; the server has the last word.
    static func isPlausibleEmail(_ text: String) -> Bool {
        let parts = text.trimmingCharacters(in: .whitespacesAndNewlines).split(
            separator: "@",
            omittingEmptySubsequences: false,
        )
        guard parts.count == 2, !parts[0].isEmpty, !parts[0].contains(" ") else { return false }
        let domain = parts[1]
        return domain.contains(".") && !domain.hasPrefix(".") && !domain.hasSuffix(".") && !domain.contains(" ")
    }

    private func run(codeStep: Bool, _ work: @escaping @MainActor () async throws(APIFailure) -> Void) async {
        isWorking = true
        problem = nil
        defer { isWorking = false }
        do {
            try await work()
        } catch {
            let problem = Self.problem(for: error, codeStep: codeStep)
            self.problem = problem
            if codeStep, problem.kind == .wrongCode || problem.kind == .codeExpired {
                code = ""
            }
        }
    }

    /// The failure in words the person can act on. The API's dev driver and the user pool name the
    /// same problems differently (docs/features/auth.md), so this goes by the code and status.
    static func problem(for failure: APIFailure, codeStep: Bool) -> SignInProblem {
        switch failure.code {
        case "network_unavailable":
            return SignInProblem(kind: .offline, message: "Can't reach Listora. Check your connection, then try again.")
        case "rate_limited":
            return SignInProblem(kind: .rateLimited, message: failure.message)
        case "invalid_code":
            return SignInProblem(kind: .wrongCode, message: "That code isn't right. Check the email and try again.")
        case "code_expired":
            return SignInProblem(kind: .codeExpired, message: "That code has expired. Send a new code.")
        case "sign_in_unavailable":
            return SignInProblem(kind: .emailNotAllowed, message: notAllowed)
        default:
            break
        }
        if failure.statusCode == 403 || (!codeStep && failure.isUnauthenticated) {
            return SignInProblem(kind: .emailNotAllowed, message: notAllowed)
        }
        if codeStep, failure.isUnauthenticated {
            // The dev driver's wrong or expired code, or a user pool sign-in that has ended: its
            // own words say which, and either way the code field starts empty.
            return SignInProblem(kind: .wrongCode, message: failure.message)
        }
        if failure.statusCode == 400 || failure.statusCode == 422, !codeStep {
            return SignInProblem(kind: .other, message: "Enter your whole email address, like you@example.com.")
        }
        return SignInProblem(kind: .other, message: failure.message)
    }

    static let notAllowed = "This email can't sign in to Listora. Check the address, or if you're new, "
        + "sign up with the invite code you were sent."
}

extension Character {
    fileprivate var isASCIIDigit: Bool {
        isASCII && isNumber
    }
}

extension SignInModel.Stage {
    /// Who is signed in, or nil.
    public var signedInEmail: String? {
        if case let .signedIn(email) = self {
            email
        } else {
            nil
        }
    }
}
