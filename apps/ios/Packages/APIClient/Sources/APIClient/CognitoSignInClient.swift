import Foundation

/// Signs in with the environment's Cognito user pool by an emailed one-time code
/// (docs/features/auth.md): `InitiateAuth` with `USER_AUTH` and `EMAIL_OTP` emails the code, and
/// `RespondToAuthChallenge` exchanges it for the pool's tokens. The API accepts the ID token,
/// which carries the verified email, so the session's bearer token is the ID token; the refresh
/// token renews it (``AccessGrantRefresher``) for 30 days.
///
/// The app client is public (no secret), so these calls need no AWS credentials: they are the
/// Cognito user pools JSON API, called directly over URLSession, and the only place the app talks
/// to anything but the Listora API. Nobody can sign up; only users the pool already has (the
/// personal environment's owner) receive a code.
public struct CognitoSignInClient: AccessGrantRefresher {
    /// A sign-in waiting for its code: Cognito's session for the challenge, valid for 10 minutes.
    public struct Challenge: Equatable, Sendable {
        public let email: String
        /// Cognito's name for the user, which the code's answer must use.
        let username: String
        let session: String
    }

    private let endpoint: URL
    private let clientID: String
    private let session: URLSession
    private let now: @Sendable () -> Date

    public init(
        region: String,
        clientID: String,
        session: URLSession = .shared,
        now: @escaping @Sendable () -> Date = Date.init,
    ) {
        // The region is validated with the configuration (AWS region names only).
        endpoint = URL(string: "https://cognito-idp.\(region).amazonaws.com/") ?? URL(filePath: "/")
        self.clientID = clientID
        self.session = session
        self.now = now
    }

    /// Emails a one-time code to `email`. An address the pool does not know gets the same answer,
    /// and then a code that never works, so the answer never says who has an account.
    public func requestCode(email: String) async throws(APIFailure) -> Challenge {
        let reply: CognitoReply = try await call("InitiateAuth", [
            "AuthFlow": "USER_AUTH",
            "ClientId": clientID,
            "AuthParameters": ["USERNAME": email, "PREFERRED_CHALLENGE": "EMAIL_OTP"],
        ])
        guard reply.challengeName == "EMAIL_OTP", let session = reply.session else {
            throw APIFailure(
                statusCode: nil,
                code: "sign_in_unavailable",
                message: "This account can't sign in with an emailed code.",
                retryable: false,
            )
        }
        return Challenge(email: email, username: reply.challengeParameters?["USERNAME"] ?? email, session: session)
    }

    /// Exchanges the emailed code for a session.
    public func signIn(_ challenge: Challenge, code: String) async throws(APIFailure) -> AccessGrant {
        let reply: CognitoReply = try await call("RespondToAuthChallenge", [
            "ChallengeName": "EMAIL_OTP",
            "ClientId": clientID,
            "Session": challenge.session,
            "ChallengeResponses": ["USERNAME": challenge.username, "EMAIL_OTP_CODE": code],
        ])
        guard let tokens = reply.authenticationResult, let refreshToken = tokens.refreshToken else {
            throw APIFailure(Unreadable())
        }
        return grant(tokens, email: challenge.email, refreshToken: refreshToken)
    }

    /// Renews the session's token with its refresh token (`REFRESH_TOKEN_AUTH`).
    public func refresh(_ grant: AccessGrant) async throws(APIFailure) -> AccessGrant {
        guard let refreshToken = grant.refreshToken else {
            throw APIFailure(statusCode: 401, code: "unauthenticated", message: Self.signInAgain, retryable: false)
        }
        let reply: CognitoReply = try await call("InitiateAuth", [
            "AuthFlow": "REFRESH_TOKEN_AUTH",
            "ClientId": clientID,
            "AuthParameters": ["REFRESH_TOKEN": refreshToken],
        ])
        guard let tokens = reply.authenticationResult else { throw APIFailure(Unreadable()) }
        // Cognito returns a new refresh token only when it rotates them.
        return self.grant(tokens, email: grant.email, refreshToken: tokens.refreshToken ?? refreshToken)
    }

    /// Revokes the session's refresh token at sign-out, so a copy of it stops working too.
    public func revoke(_ grant: AccessGrant) async throws(APIFailure) {
        guard let refreshToken = grant.refreshToken else { return }
        let _: Empty = try await call("RevokeToken", ["ClientId": clientID, "Token": refreshToken])
    }

    private static let signInAgain = "Your session has ended. Sign in again."

    private func grant(_ tokens: AuthenticationResult, email: String, refreshToken: String) -> AccessGrant {
        AccessGrant(
            accessToken: tokens.idToken,
            expiresAt: now().addingTimeInterval(TimeInterval(tokens.expiresIn)),
            email: email,
            refreshToken: refreshToken,
        )
    }

    private struct Unreadable: Error {}
    private struct Empty: Decodable {}

    private func call<Reply: Decodable>(
        _ operation: String,
        _ body: [String: Any],
    ) async throws(APIFailure) -> Reply {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-amz-json-1.1", forHTTPHeaderField: "Content-Type")
        request.setValue("AWSCognitoIdentityProviderService.\(operation)", forHTTPHeaderField: "X-Amz-Target")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIFailure(error)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(status) else {
            let type = (try? JSONDecoder().decode(ErrorReply.self, from: data))?.type
            throw Self.failure(status: status, type: type.map { String($0.split(separator: "#").last ?? "") })
        }
        do {
            return try JSONDecoder().decode(Reply.self, from: data.isEmpty ? Data("{}".utf8) : data)
        } catch {
            throw APIFailure(Unreadable())
        }
    }

    /// Cognito's exceptions in the app's words. Cognito's own messages are for developers, so none
    /// is shown.
    static func failure(status: Int, type: String?) -> APIFailure {
        let failure = { (code: String, message: String, retryable: Bool) in
            // A rejected session or refresh token reads as unauthenticated, like the API's 401.
            APIFailure(
                statusCode: code == "unauthenticated" ? 401 : status,
                code: code,
                message: message,
                retryable: retryable,
            )
        }
        switch type {
        case "CodeMismatchException":
            return failure("invalid_code", "That code isn't right. Check the email and try again.", false)
        case "ExpiredCodeException":
            return failure("code_expired", "That code has expired. Send a new one.", false)
        case "NotAuthorizedException":
            // A refresh token or a sign-in session that no longer works, or too many wrong codes.
            return failure("unauthenticated", "This sign-in has ended. Send a new code.", false)
        case "UserNotFoundException", "UserNotConfirmedException", "PasswordResetRequiredException":
            return failure("unauthenticated", "This email can't sign in to Listora.", false)
        case "TooManyRequestsException", "LimitExceededException", "TooManyFailedAttemptsException":
            return failure("rate_limited", "Too many tries. Wait a few minutes, then try again.", true)
        case "CodeDeliveryFailureException":
            return failure("service_unavailable", "Listora couldn't email the code. Try again in a few minutes.", true)
        default:
            return status >= 500
                ? failure("service_unavailable", "Sign-in isn't available right now. Try again.", true)
                : failure("sign_in_failed", "Sign-in didn't work. Try again.", false)
        }
    }
}

/// The answer of `InitiateAuth` and `RespondToAuthChallenge`: a challenge, or the tokens.
private struct CognitoReply: Decodable {
    let challengeName: String?
    let session: String?
    let challengeParameters: [String: String]?
    let authenticationResult: AuthenticationResult?

    enum CodingKeys: String, CodingKey {
        case challengeName = "ChallengeName"
        case session = "Session"
        case challengeParameters = "ChallengeParameters"
        case authenticationResult = "AuthenticationResult"
    }
}

private struct AuthenticationResult: Decodable {
    let idToken: String
    let expiresIn: Int
    let refreshToken: String?

    enum CodingKeys: String, CodingKey {
        case idToken = "IdToken"
        case expiresIn = "ExpiresIn"
        case refreshToken = "RefreshToken"
    }
}

/// Cognito's error body: `__type` names the exception, sometimes after a `namespace#`.
private struct ErrorReply: Decodable {
    let type: String
    let message: String?

    enum CodingKeys: String, CodingKey {
        case type = "__type"
        case message
    }
}
