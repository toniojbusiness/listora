import APIClient
import Core
import Foundation
import ShareLinkFeature
import Synchronization
import Testing

/// The live service against canned responses in the contract's shapes.
struct APIListingLinkServiceTests {
    private let listing = ListingURL(
        marketplace: .poshmark,
        listingId: "64f1a2b3c4d5e6f7a8b9c0d1",
        canonicalURL: URL(string: "https://poshmark.com/listing/Align-Pant-64f1a2b3c4d5e6f7a8b9c0d1")!,
    )
    private let item = ItemMatch(id: "0b9d4e8a-1c2f-4a5b-8c7d-6e5f4a3b2c1d", sku: "AJ-000184", title: "Align pant")

    /// One canned answer for every request, on a host only this test uses.
    private final class CannedServer: StubServer {
        let host = "\(UUID().uuidString.lowercased()).share.test"
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

    private func service(_ server: CannedServer, signedIn: Bool = true) throws -> APIListingLinkService {
        StubURLProtocol.register(server, hosts: [server.host])
        let grant = AccessGrant(accessToken: "token", expiresAt: .distantFuture, email: "a@b.c")
        let tokens = AccessTokenStore(storage: InMemoryAccessGrantStorage(signedIn ? grant : nil))
        let api = try APIClient(
            baseURL: #require(URL(string: "https://\(server.host)")),
            accessTokens: tokens,
            session: URLSession(configuration: StubURLProtocol.configuration()),
        )
        return APIListingLinkService(api: api, accessTokens: tokens)
    }

    @Test
    func `is signed in only with a session`() throws {
        #expect(try service(CannedServer(status: 200, body: "{}")).isSignedIn())
        #expect(try !service(CannedServer(status: 200, body: "{}"), signedIn: false).isSignedIn())
    }

    @Test
    func `searches items and reads which marketplaces each is live on`() async throws {
        let server = CannedServer(status: 200, body: itemPageJSON)
        let found = try await service(server).searchItems("  lulu ")

        let request = try #require(server.requests.first)
        #expect(request.path == "/v1/items")
        #expect(request.url.query() == "q=lulu&limit=25")
        #expect(found.map(\.sku) == ["AJ-000184", "AJ-000185", "AJ-000186"])
        #expect(found[0].liveMarketplaces == ["poshmark"])
        #expect(found[0].acceptsLinks)
        // An ended listing is history, and a listing on a marketplace added later still counts.
        #expect(found[1].liveMarketplaces == ["vinted"])
        #expect(!found[2].acceptsLinks)
    }

    @Test
    func `asks for the newest items when the query is empty`() async throws {
        let server = CannedServer(status: 200, body: #"{"data":[]}"#)
        _ = try await service(server).searchItems("")
        #expect(server.requests.first?.url.query() == "limit=25")
    }

    @Test
    func `links the canonical URL with the Idempotency-Key and shows the server's status`() async throws {
        let server = CannedServer(status: 201, body: listingJSON)
        let linked = try await service(server).link(listing, to: item, idempotencyKey: "key-1")

        let request = try #require(server.requests.first)
        #expect(request.method == "POST")
        #expect(request.path == "/v1/items/\(item.id)/listing-links")
        #expect(request.header("Idempotency-Key") == "key-1")
        #expect(request.header("Authorization") == "Bearer token")
        #expect(String(bytes: request.body, encoding: .utf8)?.contains(#"poshmark.com\/listing\/Align-Pant"#) == true)
        #expect(linked == LinkedListing(
            itemSKU: "AJ-000184",
            itemTitle: "Align pant",
            statusLabel: "Active (you confirmed)",
            statusTone: .success,
        ))
    }

    @Test
    func `imports a listing as a new item`() async throws {
        let server = CannedServer(status: 201, body: importResultJSON)
        let linked = try await service(server).importListing(listing, title: "Align pant", idempotencyKey: "key-2")

        #expect(server.requests.first?.path == "/v1/listing-imports")
        #expect(linked.itemSKU == "AJ-000190")
        #expect(linked.itemTitle == "Align pant")
        #expect(linked.statusLabel == "Active (you confirmed)")
    }

    @Test
    func `reports the server's refusal as given`() async throws {
        let server = CannedServer(status: 409, body: #"""
        {"error":{"code":"already_exists","message":"This Poshmark listing is already linked to AJ-000101.",
        "retryable":false,"requestId":"r1"}}
        """#)
        await #expect(throws: APIFailure(
            statusCode: 409,
            code: "already_exists",
            message: "This Poshmark listing is already linked to AJ-000101.",
            retryable: false,
            requestID: "r1",
        )) {
            try await service(server).link(listing, to: item, idempotencyKey: "key-1")
        }
    }

    @Test
    func `a response that does not decode is a retryable failure, never a success`() async throws {
        let server = CannedServer(status: 201, body: #"{"unexpected":true}"#)
        let service = try service(server)
        do {
            _ = try await service.link(listing, to: item, idempotencyKey: "key-1")
            Issue.record("expected a failure")
        } catch {
            #expect(error.code == "invalid_response")
            #expect(error.retryable)
        }
    }
}

private let itemPageJSON = """
{"data":[
  {"id":"0b9d4e8a-1c2f-4a5b-8c7d-6e5f4a3b2c1d","sku":"AJ-000184","status":"listed","title":"Align pant",
   "listings":[{"listingId":"5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d","marketplace":"poshmark","mode":"assisted",
     "status":"active","statusDisplay":{"tone":"success","label":"Active (you confirmed)"}}],
   "createdAt":"2026-10-24T12:00:00Z","updatedAt":"2026-10-24T12:00:00Z"},
  {"id":"1b9d4e8a-1c2f-4a5b-8c7d-6e5f4a3b2c1d","sku":"AJ-000185","status":"ready",
   "listings":[
     {"listingId":"6a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d","marketplace":"ebay","mode":"api","status":"ended",
      "statusDisplay":{"tone":"success","label":"Ended (confirmed by eBay)"}},
     {"listingId":"7a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d","marketplace":"vinted","mode":"partner_api",
      "status":"paused","statusDisplay":{"tone":"paused","label":"Paused on Vinted"}}],
   "createdAt":"2026-10-24T12:00:00Z","updatedAt":"2026-10-24T12:00:00Z"},
  {"id":"2b9d4e8a-1c2f-4a5b-8c7d-6e5f4a3b2c1d","sku":"AJ-000186","status":"sold","listings":[],
   "createdAt":"2026-10-24T12:00:00Z","updatedAt":"2026-10-24T12:00:00Z"}
]}
"""

private let listingJSON = """
{"id":"5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d","itemId":"0b9d4e8a-1c2f-4a5b-8c7d-6e5f4a3b2c1d",
 "marketplace":"poshmark","mode":"assisted","status":"active",
 "statusDisplay":{"tone":"success","label":"Active (you confirmed)"},
 "verification":{"method":"user_confirmation","verifiedAt":"2026-10-24T12:00:00Z"},
 "externalListingId":"64f1a2b3c4d5e6f7a8b9c0d1",
 "externalUrl":"https://poshmark.com/listing/Align-Pant-64f1a2b3c4d5e6f7a8b9c0d1",
 "availableActions":[],"createdAt":"2026-10-24T12:00:00Z","updatedAt":"2026-10-24T12:00:00Z"}
"""

private let linkedListingJSON = listingJSON

private let importResultJSON = """
{"item":{"id":"0b9d4e8a-1c2f-4a5b-8c7d-6e5f4a3b2c1d","sku":"AJ-000190","status":"listed","version":2,
  "details":{"title":"Align pant","quantity":1},"fieldProvenance":{"title":"user"},"photos":[],
  "listings":[\(listingJSON)],"createdAt":"2026-10-24T12:00:00Z","updatedAt":"2026-10-24T12:00:00Z"},
 "listing":\(listingJSON)}
"""
