import Foundation
import ListoraAPI

/// Signs in against the API's dev auth driver (`AUTH_DRIVER=dev`): the API prints a one-time code
/// to its log, and exchanging that code returns a session token. These endpoints exist only in
/// development and are deliberately outside the OpenAPI contract, so this is the one place the app
/// calls the API without the generated client. Production sign-in (Cognito) replaces it (T-31).
public struct DevSignInClient: Sendable {
    private let baseURL: URL
    private let session: URLSession
    private let now: @Sendable () -> Date

    public init(baseURL: URL, session: URLSession = .shared, now: @escaping @Sendable () -> Date = Date.init) {
        self.baseURL = baseURL
        self.session = session
        self.now = now
    }

    /// Asks the API to print a sign-in code for `email` to its log.
    public func requestCode(email: String) async throws(APIFailure) {
        _ = try await post("dev/auth/codes", body: ["email": email])
    }

    /// Exchanges the code from the API log for a session.
    public func signIn(email: String, code: String) async throws(APIFailure) -> AccessGrant {
        let data = try await post("dev/auth/sessions", body: ["email": email, "code": code])
        guard let session = try? JSONDecoder().decode(Session.self, from: data) else {
            throw APIFailure(UnreadableSession())
        }
        return AccessGrant(
            accessToken: session.accessToken,
            expiresAt: now().addingTimeInterval(TimeInterval(session.expiresInSeconds)),
            email: email,
        )
    }

    private struct UnreadableSession: Error {}

    private struct Session: Decodable {
        let accessToken: String
        let expiresInSeconds: Int
    }

    private func post(_ path: String, body: [String: String]) async throws(APIFailure) -> Data {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(body)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIFailure(error)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(status) else {
            if let error = try? JSONDecoder().decode(Components.Schemas.ErrorResponse.self, from: data) {
                throw APIFailure(statusCode: status, response: DecodedError(errorResponse: error))
            }
            throw APIFailure(statusCode: status, code: "invalid_response", message: "Sign-in failed.", retryable: true)
        }
        return data
    }

    private struct DecodedError: ErrorResponseCarrying {
        let errorResponse: Components.Schemas.ErrorResponse
    }
}
