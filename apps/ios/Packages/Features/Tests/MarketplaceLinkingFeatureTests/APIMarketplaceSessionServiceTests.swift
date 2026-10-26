import APIClient
import Foundation
import Synchronization
import Testing
@testable import MarketplaceLinkingFeature

/// The live service against canned responses in the contract's shapes, and the cookie capture.
struct APIMarketplaceSessionServiceTests {
    /// One canned answer for every request, on a host only this test uses.
    private final class CannedServer: StubServer {
        let host = "\(UUID().uuidString.lowercased()).sessions.test"
        private let reply: StubReply
        private let received = Mutex<[StubRequest]>([])

        init(status: Int, body: String) {
            reply = StubReply(status: status, body: Data(body.utf8))
        }

        var requests: [StubRequest] {
            received.withLock { $0 }
        }

        func reply(to request: StubRequest) -> StubReply? {
            received.withLock { $0.append(request) }
            return reply
        }
    }

    private func service(_ server: CannedServer) throws -> APIMarketplaceSessionService {
        StubURLProtocol.register(server, hosts: [server.host])
        let grant = AccessGrant(accessToken: "token", expiresAt: .distantFuture, email: "a@b.c")
        let api = try APIClient(
            baseURL: #require(URL(string: "https://\(server.host)")),
            accessTokens: AccessTokenStore(storage: InMemoryAccessGrantStorage(grant)),
            session: URLSession(configuration: StubURLProtocol.configuration()),
        )
        return APIMarketplaceSessionService(api: api)
    }

    @Test
    func `reads every marketplace's state as the server reports it`() async throws {
        let server = CannedServer(status: 200, body: """
        {"data":[
          {"marketplace":"poshmark","status":"linked","statusDisplay":{"tone":"success","label":"Linked"},
           "login":{"url":"https://poshmark.com/login","cookieDomains":["poshmark.com"]},
           "displayName":"closet_queen","linkedAt":"2026-10-24T12:00:00Z","checkedAt":"2026-10-24T12:00:30Z"},
          {"marketplace":"mercari","status":"needs_relink",
           "statusDisplay":{"tone":"action_needed","label":"Sign in again","detail":"Mercari logged Listora out."},
           "login":{"url":"https://www.mercari.com/login/","cookieDomains":["mercari.com"]},
           "issue":{"code":"session_rejected","message":"Mercari logged Listora out.",
                    "occurredAt":"2026-10-24T12:00:00Z"}},
          {"marketplace":"depop","status":"paused_by_depop","statusDisplay":{"tone":"sparkly","label":"Paused"},
           "login":{"url":"https://www.depop.com/login/","cookieDomains":["depop.com"]}}
        ]}
        """)
        let links = try await service(server).list()

        #expect(links.map(\.marketplace) == ["poshmark", "mercari", "depop"])
        #expect(links[0].state == .linked)
        #expect(links[0].statusTone == .success)
        #expect(links[0].displayName == "closet_queen")
        #expect(links[0].loginURL.absoluteString == "https://poshmark.com/login")
        #expect(links[1].state == .needsRelink(message: "Mercari logged Listora out."))
        #expect(links[1].statusTone == .actionNeeded)
        // A status and tone added after this build: shown as given, and linking stays possible.
        #expect(links[2].state == .unknown)
        #expect(links[2].statusLabel == "Paused")
        #expect(links[2].statusTone == .neutral)
        #expect(links[2].canLink)
        #expect(server.requests.first?.path == "/v1/marketplace-sessions")
    }

    @Test
    func `sends the cookies with the Idempotency-Key, and nothing else`() async throws {
        let server = CannedServer(status: 201, body: """
        {"marketplace":"poshmark","status":"checking","statusDisplay":{"tone":"checking","label":"Checking..."},
         "login":{"url":"https://poshmark.com/login","cookieDomains":["poshmark.com"]}}
        """)
        let linked = try await service(server).link(
            "poshmark",
            cookies: [CapturedCookie(
                name: "jwt",
                value: "session-token",
                domain: ".poshmark.com",
                path: "/",
                expires: 1_900_000_000,
                httpOnly: true,
                secure: true,
                sameSite: .lax,
            )],
            idempotencyKey: "key-1",
        )

        #expect(linked.state == .checking)
        let request = try #require(server.requests.first)
        #expect(request.method == "POST")
        #expect(request.path == "/v1/marketplace-sessions/poshmark")
        #expect(request.header("Idempotency-Key") == "key-1")
        let body = try #require(JSONSerialization.jsonObject(with: request.body) as? [String: Any])
        #expect(Set(body.keys) == ["cookies"])
        let cookies = try #require(body["cookies"] as? [[String: Any]])
        #expect(cookies.count == 1)
        #expect(cookies[0]["value"] as? String == "session-token")
        #expect(cookies[0]["sameSite"] as? String == "lax")
        #expect(cookies[0]["expires"] as? Int == 1_900_000_000)
    }

    @Test
    func `reports a refused session with the server's message`() async throws {
        let server = CannedServer(status: 422, body: """
        {"error":{"code":"validation_failed","message":"Listora couldn't use this Poshmark sign-in. Sign in again.",
         "retryable":false,"requestId":"req-1","fieldErrors":[{"field":"cookies","message":"bad"}]}}
        """)
        let sessions = try service(server)
        do {
            _ = try await sessions.link("poshmark", cookies: [], idempotencyKey: "k")
            Issue.record("expected the link to fail")
        } catch {
            #expect(error.statusCode == 422)
            #expect(error.message == "Listora couldn't use this Poshmark sign-in. Sign in again.")
            #expect(!error.retryable)
        }
    }

    /// A `Connection` for an unlinked marketplace, in the contract's shape.
    private static let unlinkedConnection = """
    {"marketplace":"poshmark","mode":"assisted","status":"not_connected",
     "statusDisplay":{"tone":"neutral","label":"Not linked"},
     "capabilities":{"connect":"none","create":"assisted","updatePrice":"assisted","updateDetails":"assisted",
       "delist":"assisted","relist":"assisted","markSold":"assisted","verifyRead":"user_confirm",
       "importListings":"none","saleDetection":["manual"],"imageTransport":"url_fetch"},
     "availableActions":[]}
    """

    @Test
    func `unlinks with a DELETE of the marketplace's connection`() async throws {
        let server = CannedServer(status: 200, body: Self.unlinkedConnection)
        try await service(server).unlink("poshmark")
        let request = try #require(server.requests.first)
        #expect(request.method == "DELETE")
        #expect(request.path == "/v1/connections/poshmark")
    }

    @Test
    func `treats nothing linked as unlinked, so a retry after a lost answer succeeds`() async throws {
        let server = CannedServer(status: 404, body: """
        {"error":{"code":"not_found","message":"No Poshmark account is linked to Listora.","retryable":false,
         "requestId":"r1"}}
        """)
        try await service(server).unlink("poshmark")
    }

    @Test
    func `reports a failed unlink with the server's words`() async throws {
        let server = CannedServer(status: 503, body: """
        {"error":{"code":"service_unavailable","message":"Listora is busy. Try again.","retryable":true,
         "requestId":"r2"}}
        """)
        do {
            try await service(server).unlink("poshmark")
            Issue.record("the unlink did not fail")
        } catch let error as APIFailure {
            #expect(error.statusCode == 503)
            #expect(error.message == "Listora is busy. Try again.")
            #expect(error.retryable)
        } catch {
            Issue.record("unexpected error \(error)")
        }
    }
}

struct SessionCookiesTests {
    @Test
    func `keeps only the marketplace's own live cookies`() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let captured = SessionCookies.capture(
            [
                cookie("jwt", "a", domain: ".poshmark.com", expires: now.addingTimeInterval(3600)),
                cookie("ui", "b", domain: "www.poshmark.com"),
                cookie("old", "c", domain: "poshmark.com", expires: now.addingTimeInterval(-60)),
                cookie("_ga", "d", domain: ".google.com"),
                cookie("spoof", "e", domain: "notposhmark.com"),
                cookie("tail", "f", domain: "poshmark.com.evil.example"),
            ],
            domains: ["poshmark.com"],
            now: now,
        )
        #expect(captured.map(\.name) == ["jwt", "ui"])
        #expect(captured[0].expires == 1_800_003_600)
        #expect(captured[1].expires == -1)
        #expect(captured.allSatisfy { $0.sameSite == .lax && $0.path == "/" })
    }

    @Test
    func `reads the cookie's flags and SameSite policy`() throws {
        let strict = try #require(HTTPCookie(properties: [
            .name: "sid", .value: "v", .domain: "127.0.0.1", .path: "/app",
            .secure: "TRUE", .sameSitePolicy: HTTPCookieStringPolicy.sameSiteStrict.rawValue,
        ]))
        let captured = CapturedCookie(strict)
        #expect(captured.secure)
        #expect(captured.sameSite == .strict)
        #expect(captured.path == "/app")
        #expect(captured.domain == "127.0.0.1")
    }
}
