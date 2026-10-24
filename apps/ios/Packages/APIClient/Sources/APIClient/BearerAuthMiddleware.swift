import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Adds the signed-in session's bearer token to every request, and tells the token provider when
/// the server rejects it (`401`), so the app shows "signed out" instead of retrying with it.
struct BearerAuthMiddleware: ClientMiddleware {
    let accessTokens: any AccessTokenProvider

    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID _: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?),
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var request = request
        let token = await accessTokens.accessToken()
        if let token {
            request.headerFields[.authorization] = "Bearer \(token)"
        }
        let (response, responseBody) = try await next(request, body, baseURL)
        if response.status == .unauthorized, let token {
            await accessTokens.reject(token)
        }
        return (response, responseBody)
    }
}
