import Foundation
import HTTPTypes
import ListoraAPI
import OpenAPIRuntime
import Synchronization
import Testing
@testable import APIClient

struct APIClientTests {
    @Test
    func `keeps the configured base URL`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:3000"))
        let tokens = AccessTokenStore(storage: InMemoryAccessGrantStorage())
        #expect(APIClient(baseURL: url, accessTokens: tokens).baseURL == url)
    }

    @Test
    func `reads timestamps with and without fractional seconds`() throws {
        let transcoder = ISO8601Timestamps()

        let fractional = try transcoder.decode("2026-10-24T12:00:00.250Z")
        let whole = try transcoder.decode("2026-10-24T12:00:00Z")

        #expect(fractional.timeIntervalSince(whole) == 0.25)
        #expect(try transcoder.encode(fractional) == "2026-10-24T12:00:00.250Z")
        #expect(throws: (any Error).self) { try transcoder.decode("yesterday") }
    }
}

struct BearerAuthMiddlewareTests {
    private func send(
        through middleware: BearerAuthMiddleware,
        answer status: HTTPResponse.Status,
    ) async throws -> HTTPRequest {
        let sent = Mutex<HTTPRequest?>(nil)
        _ = try await middleware.intercept(
            HTTPRequest(method: .get, scheme: "https", authority: "api.test", path: "/v1/items"),
            body: nil,
            baseURL: URL(filePath: "/"),
            operationID: "listItems",
        ) { request, _, _ in
            sent.withLock { $0 = request }
            return (HTTPResponse(status: status), nil)
        }
        return try #require(sent.withLock { $0 })
    }

    @Test
    func `sends the session's token as a bearer token`() async throws {
        let tokens = AccessTokenStore(storage: InMemoryAccessGrantStorage(.test))

        let request = try await send(through: BearerAuthMiddleware(accessTokens: tokens), answer: .ok)

        #expect(request.headerFields[.authorization] == "Bearer token-1")
        #expect(tokens.grant == .test)
    }

    @Test
    func `sends no token when signed out`() async throws {
        let tokens = AccessTokenStore(storage: InMemoryAccessGrantStorage())

        let request = try await send(through: BearerAuthMiddleware(accessTokens: tokens), answer: .ok)

        #expect(request.headerFields[.authorization] == nil)
    }

    @Test
    func `a 401 signs the session out`() async throws {
        let storage = InMemoryAccessGrantStorage(.test)
        let tokens = AccessTokenStore(storage: storage)

        _ = try await send(through: BearerAuthMiddleware(accessTokens: tokens), answer: .unauthorized)

        #expect(tokens.grant == nil)
        #expect(storage.load() == nil)
    }
}

struct AccessTokenStoreTests {
    @Test
    func `an expired session reads as signed out`() async {
        let tokens = AccessTokenStore(
            storage: InMemoryAccessGrantStorage(AccessGrant(
                accessToken: "old",
                expiresAt: .distantPast,
                email: "a@b.c",
            )),
        )

        #expect(tokens.grant == nil)
        #expect(await tokens.accessToken() == nil)
    }

    @Test
    func `rejecting a token that is no longer current keeps the new session`() async {
        let tokens = AccessTokenStore(storage: InMemoryAccessGrantStorage(.test))
        let next = AccessGrant(accessToken: "token-2", expiresAt: .distantFuture, email: "a@b.c")
        tokens.signIn(next)

        await tokens.reject("token-1")

        #expect(tokens.grant == next)
    }

    @Test
    func `observers hear the current session and every change`() async {
        let storage = InMemoryAccessGrantStorage()
        let tokens = AccessTokenStore(storage: storage)
        var changes = tokens.changes().makeAsyncIterator()

        #expect(await changes.next() == .some(nil))
        tokens.signIn(.test)
        #expect(await changes.next() == .some(.test))
        #expect(storage.load() == .test)
        tokens.signOut()
        #expect(await changes.next() == .some(nil))
        #expect(storage.load() == nil)
    }
}

struct APIFailureTests {
    @Test
    func `reads the server's error body`() {
        let response = Components.Responses.DefaultError(body: .json(.init(error: .init(
            code: .init(value1: .rateLimited),
            message: "Slow down.",
            retryable: true,
            retryAfterSeconds: 12,
            requestId: "req-1",
        ))))

        let failure = APIFailure(statusCode: 429, response: response)

        #expect(failure.code == "rate_limited")
        #expect(failure.knownCode == .rateLimited)
        #expect(failure.message == "Slow down.")
        #expect(failure.retryable)
        #expect(failure.retryAfter == .seconds(12))
        #expect(failure.requestID == "req-1")
    }

    @Test
    func `keeps a code added after this build`() {
        let response = Components.Responses.DefaultError(body: .json(.init(error: .init(
            code: .init(value2: "code_added_later"),
            message: "New problem.",
            retryable: false,
            requestId: "req-2",
        ))))

        let failure = APIFailure(statusCode: 409, response: response)

        #expect(failure.code == "code_added_later")
        #expect(failure.knownCode == nil)
        #expect(!failure.retryable)
    }

    @Test
    func `a connection failure is retryable and says so plainly`() {
        let failure = APIFailure(URLError(.notConnectedToInternet))

        #expect(failure == .networkUnavailable)
        #expect(failure.retryable)
        #expect(failure.statusCode == nil)
    }
}

extension AccessGrant {
    static let test = AccessGrant(accessToken: "token-1", expiresAt: .distantFuture, email: "seller@example.com")
}
