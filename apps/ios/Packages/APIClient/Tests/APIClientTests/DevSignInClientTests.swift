import APIClient
import Foundation
import Synchronization
import Testing

struct DevSignInClientTests {
    private let host = "dev-auth-\(UUID().uuidString.lowercased()).test"

    private func client(now: Date = Date(timeIntervalSince1970: 1000)) throws -> DevSignInClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DevAuthStub.self]
        return try DevSignInClient(
            baseURL: #require(URL(string: "https://\(host)")),
            session: URLSession(configuration: configuration),
            now: { now },
        )
    }

    @Test
    func `exchanges the code from the API log for a session`() async throws {
        DevAuthStub.answer(host: host) { request in
            guard request.url?.path(percentEncoded: false) == "/dev/auth/sessions" else { return (404, "{}") }
            return (200, #"{"accessToken":"jwt-1","tokenType":"Bearer","expiresInSeconds":86400}"#)
        }

        let grant = try await client().signIn(email: "seller@example.com", code: "123456")

        #expect(grant.accessToken == "jwt-1")
        #expect(grant.email == "seller@example.com")
        #expect(grant.expiresAt == Date(timeIntervalSince1970: 1000 + 86400))
    }

    @Test
    func `shows the API's message when the code is wrong`() async throws {
        DevAuthStub.answer(host: host) { _ in
            (
                401,
                #"{"error":{"code":"unauthenticated","message":"That sign-in code is not correct.","#
                    + #""retryable":false,"requestId":"r"}}"#,
            )
        }

        let client = try client()
        let failure = await #expect(throws: APIFailure.self) {
            try await client.signIn(email: "seller@example.com", code: "000000")
        }
        #expect(failure?.message == "That sign-in code is not correct.")
        #expect(failure?.isUnauthenticated == true)
    }
}

/// Answers requests per host (the dev auth API's, and Cognito's), so tests can run in parallel.
final class DevAuthStub: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) -> (Int, String)
    private static let handlers = Mutex<[String: Handler]>([:])

    static func answer(host: String, with handler: @escaping Handler) {
        handlers.withLock { $0[host] = handler }
    }

    override static func canInit(with request: URLRequest) -> Bool {
        guard let host = request.url?.host() else { return false }
        return handlers.withLock { $0[host] != nil }
    }

    override static func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let url = request.url, let host = url.host(), let handler = Self.handlers.withLock({ $0[host] })
        else { return }
        // Once per request: handlers may record what they were sent.
        let (status, body) = handler(request)
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: [
            "Content-Type": "application/json",
        ]) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
