import APIClient
import Foundation
import ListoraAPI
import Observation

/// What redeeming an invite answered: the email the invite now belongs to, and whether the
/// sign-in codes reach it yet.
public struct InviteRedemption: Equatable, Sendable {
    public let email: String
    /// False while the address waits for the verification link its owner was emailed (SES's
    /// sandbox); ``message`` says what to do.
    public let isReady: Bool
    /// What to do next, in the server's words.
    public let message: String

    public init(email: String, isReady: Bool, message: String) {
        self.email = email
        self.isReady = isReady
        self.message = message
    }
}

/// Redeems an invite code with the invitee's email (`redeemInvite`, docs/features/invites.md):
/// the first step of signing up, before there is a session.
public protocol InviteRedeemer: Sendable {
    func redeem(code: String, email: String) async throws(APIFailure) -> InviteRedemption
}

/// ``InviteRedeemer`` over the generated client. The operation is public, so it works signed out.
public struct APIInviteRedeemer: InviteRedeemer {
    private let client: Client

    public init(client: Client) {
        self.client = client
    }

    public func redeem(code: String, email: String) async throws(APIFailure) -> InviteRedemption {
        let output: Operations.RedeemInvite.Output
        do {
            // Redeeming is safe to repeat, so every try is its own key.
            output = try await client.redeemInvite(
                headers: .init(idempotencyKey: UUID().uuidString),
                body: .json(.init(code: code, email: email)),
            )
        } catch {
            throw APIFailure(error)
        }
        let redemption: Components.Schemas.InviteRedemption
        switch output {
        case let .ok(response):
            do {
                redemption = try response.body.json
            } catch {
                throw APIFailure(error)
            }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .tooManyRequests(response): throw APIFailure(statusCode: 429, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
        // A status this build does not know: show the message, and let the person redeem again.
        return InviteRedemption(
            email: redemption.email,
            isReady: redemption.status.value1 == .ready,
            message: redemption.message,
        )
    }
}

extension SignInModel {
    /// Opens the invite sign-up, with the code of an invite link when there is one. Someone already
    /// signed in stays where they are.
    public func openInvite(code: String?) {
        guard let invite, !isSignedIn else { return }
        if let code {
            invite.open(code: code)
        }
        if stage == .enterCode {
            startOver()
        }
        showsInvite = true
    }

    /// The invite is the email's now: sign in with it, by the code emailed there.
    func signUp(email: String) async {
        self.email = email
        await requestCode()
    }
}

/// Signing up with an invite: the code the person was sent and their own email. Once the invite is
/// theirs, the sign-in carries on as usual with the code emailed to that address; their first
/// signed-in request creates their own, separate account.
@MainActor
@Observable
public final class InviteSignUpModel {
    /// The invite code as typed; case, spaces, and dashes do not matter.
    public var code = ""
    public var email = ""
    public private(set) var isWorking = false
    /// Why the last try did not work, safe to show.
    public private(set) var problem: String?
    /// The server's words while the address waits for its verification link; Continue then
    /// redeems again.
    public private(set) var verification: String?

    private let redeemer: any InviteRedeemer
    private let continueSignIn: @MainActor (String) async -> Void

    /// `continueSignIn` requests the emailed sign-in code for the invite's email.
    public init(redeemer: any InviteRedeemer, continueSignIn: @escaping @MainActor (String) async -> Void) {
        self.redeemer = redeemer
        self.continueSignIn = continueSignIn
    }

    public var canRedeem: Bool {
        !isWorking && InviteLink.isCode(code) && SignInModel.isPlausibleEmail(email)
    }

    /// Starts over with a code from an invite link, keeping the email.
    public func open(code: String) {
        self.code = code
        problem = nil
        verification = nil
    }

    public func redeem() async {
        guard canRedeem else { return }
        let email = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        isWorking = true
        problem = nil
        defer { isWorking = false }
        do {
            let redemption = try await redeemer.redeem(code: code, email: email)
            self.email = redemption.email
            if redemption.isReady {
                verification = nil
                await continueSignIn(redemption.email)
            } else {
                verification = redemption.message
            }
        } catch {
            problem = Self.problem(for: error)
        }
    }

    /// A different email: the verification wait ends, and the next try moves the invite to it.
    public func emailChanged() {
        verification = nil
    }

    static func problem(for failure: APIFailure) -> String {
        if failure.code == "network_unavailable" {
            return "Can't reach Listora. Check your connection, then try again."
        }
        return failure.message
    }
}
