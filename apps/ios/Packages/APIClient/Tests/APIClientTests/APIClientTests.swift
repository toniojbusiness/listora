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
    func `a gateway error without Listora's body is a retryable server error, not an unreadable answer`() {
        // What the API gateway answers while the service restarts: a 503 with its own body.
        let error = ClientError(
            operationID: "endListing",
            operationInput: (),
            request: nil,
            requestBody: nil,
            baseURL: nil,
            response: HTTPResponse(status: .serviceUnavailable),
            responseBody: nil,
            causeDescription: "Unexpected content type",
            underlyingError: DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "not JSON")),
        )

        let failure = APIFailure(error)

        #expect(failure.code == "server_unavailable")
        #expect(failure.statusCode == 503)
        #expect(failure.retryable)
        #expect(failure.message == "Listora couldn't answer just now. Try again in a moment.")
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

/// Renews sessions on demand, counting the calls; `answer` decides each outcome.
final class FakeRefresher: AccessGrantRefresher {
    let calls = Mutex(0)
    private let answer: @Sendable (AccessGrant) async throws(APIFailure) -> AccessGrant

    init(_ answer: @escaping @Sendable (AccessGrant) async throws(APIFailure) -> AccessGrant) {
        self.answer = answer
    }

    func refresh(_ grant: AccessGrant) async throws(APIFailure) -> AccessGrant {
        calls.withLock { $0 += 1 }
        return try await answer(grant)
    }
}

struct AccessTokenRefreshTests {
    private static let start = Date(timeIntervalSince1970: 10000)
    private static let expiring = AccessGrant(
        accessToken: "id-1",
        expiresAt: start.addingTimeInterval(60),
        email: "owner@example.com",
        refreshToken: "refresh-1",
    )
    private static let renewed = AccessGrant(
        accessToken: "id-2",
        expiresAt: start.addingTimeInterval(3600),
        email: "owner@example.com",
        refreshToken: "refresh-1",
    )

    @Test
    func `renews a token that expires within the margin before sending it, and saves the renewal`() async {
        let storage = InMemoryAccessGrantStorage(Self.expiring)
        let refresher = FakeRefresher { _ in Self.renewed }
        let tokens = AccessTokenStore(storage: storage, refresher: refresher, now: { Self.start })

        #expect(await tokens.accessToken() == "id-2")
        #expect(storage.load() == Self.renewed)
        // The renewed token is good for an hour: no second refresh.
        #expect(await tokens.accessToken() == "id-2")
        #expect(refresher.calls.withLock { $0 } == 1)
    }

    @Test
    func `sends a token that is not close to expiring without refreshing`() async {
        let fresh = AccessGrant(
            accessToken: "id-1", expiresAt: Self.start.addingTimeInterval(3600),
            email: "o@e.com", refreshToken: "r",
        )
        let refresher = FakeRefresher { _ in Self.renewed }
        let tokens = AccessTokenStore(
            storage: InMemoryAccessGrantStorage(fresh),
            refresher: refresher,
            now: { Self.start },
        )

        #expect(await tokens.accessToken() == "id-1")
        #expect(refresher.calls.withLock { $0 } == 0)
    }

    @Test
    func `many requests waiting for a renewal share one refresh`() async {
        let refresher = FakeRefresher { _ in
            try? await Task.sleep(for: .milliseconds(50))
            return Self.renewed
        }
        let tokens = AccessTokenStore(
            storage: InMemoryAccessGrantStorage(Self.expiring), refresher: refresher, now: { Self.start },
        )

        let sent = await withTaskGroup(of: String?.self) { group in
            for _ in 0 ..< 8 {
                group.addTask { await tokens.accessToken() }
            }
            return await group.reduce(into: []) { $0.append($1) }
        }

        #expect(sent == Array(repeating: "id-2", count: 8))
        #expect(refresher.calls.withLock { $0 } == 1)
    }

    @Test
    func `an expired session that can be renewed still reads as signed in`() {
        let expired = AccessGrant(accessToken: "id-1", expiresAt: .distantPast, email: "o@e.com", refreshToken: "r")
        let refreshable = AccessTokenStore(
            storage: InMemoryAccessGrantStorage(expired), refresher: FakeRefresher { _ in Self.renewed },
        )
        #expect(refreshable.grant == expired)
        // Without a refresher (or a refresh token), it simply ended.
        #expect(AccessTokenStore(storage: InMemoryAccessGrantStorage(expired)).grant == nil)
    }

    @Test
    func `a refresh token that no longer works signs the session out`() async {
        let storage = InMemoryAccessGrantStorage(Self.expiring)
        let refresher = FakeRefresher { _ throws(APIFailure) in
            throw APIFailure(statusCode: 401, code: "unauthenticated", message: "Sign in again.", retryable: false)
        }
        let tokens = AccessTokenStore(storage: storage, refresher: refresher, now: { Self.start })

        #expect(await tokens.accessToken() == nil)
        #expect(tokens.grant == nil)
        #expect(storage.load() == nil)
    }

    @Test
    func `without a connection the session stays, with its token until that expires`() async {
        let storage = InMemoryAccessGrantStorage(Self.expiring)
        let refresher = FakeRefresher { _ throws(APIFailure) in throw .networkUnavailable }
        let now = Mutex(Self.start)
        let tokens = AccessTokenStore(storage: storage, refresher: refresher, now: { now.withLock { $0 } })

        #expect(await tokens.accessToken() == "id-1")
        now.withLock { $0 = Self.start.addingTimeInterval(120) }
        #expect(await tokens.accessToken() == nil)
        #expect(tokens.grant == Self.expiring)
        #expect(storage.load() == Self.expiring)
    }

    @Test
    func `a sign-out during a refresh wins over the renewed session`() async {
        let storage = InMemoryAccessGrantStorage(Self.expiring)
        let tokensBox = Mutex<AccessTokenStore?>(nil)
        let refresher = FakeRefresher { _ in
            tokensBox.withLock { $0 }?.signOut()
            return Self.renewed
        }
        let tokens = AccessTokenStore(storage: storage, refresher: refresher, now: { Self.start })
        tokensBox.withLock { $0 = tokens }

        #expect(await tokens.accessToken() == nil)
        #expect(tokens.grant == nil)
        #expect(storage.load() == nil)
    }

    @Test
    func `a session saved before refresh tokens existed still reads`() throws {
        let saved = Data(#"{"accessToken":"t","expiresAt":0,"email":"a@b.c"}"#.utf8)
        let grant = try JSONDecoder().decode(AccessGrant.self, from: saved)
        #expect(grant.refreshToken == nil)
        #expect(grant.accessToken == "t")
    }
}
