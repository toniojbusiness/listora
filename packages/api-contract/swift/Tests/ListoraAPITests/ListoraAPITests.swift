import Foundation
import HTTPTypes
import ListoraAPI
import OpenAPIRuntime
import Testing

/// Exercises the generated client end to end against a stub transport: request encoding
/// (path, headers, body) and response decoding, including the error model.
@Suite struct ListoraAPIClientTests {
    @Test func createItemSendsIdempotencyKeyAndDecodesTheItem() async throws {
        let transport = StubTransport(status: .created, body: itemJSON)
        let client = Client(serverURL: try Servers.Server1.url(), transport: transport)

        let output = try await client.createItem(
            headers: .init(idempotencyKey: "7f1c3c1e-2b8a-4c55-9d43-0f5a2c8f9e10"),
            body: .json(.init(details: .init(title: "Vintage denim jacket")))
        )

        let request = try #require(await transport.lastRequest)
        #expect(request.method == .post)
        #expect(request.path == "/v1/items")
        #expect(request.headerFields[HTTPField.Name("Idempotency-Key")!] == "7f1c3c1e-2b8a-4c55-9d43-0f5a2c8f9e10")
        let sentBody = try #require(await transport.lastBody)
        #expect(String(decoding: sentBody, as: UTF8.self).contains("Vintage denim jacket"))

        let item = try output.created.body.json
        #expect(item.sku == "AJ-000184")
        #expect(item.status.value1 == .draft)
        #expect(item.storageLocation?.code == "B-12")
        #expect(item.fieldProvenance?.additionalProperties["title"]?.value1 == .user)
        #expect(item.details.listPrice?.amountCents == 3400)
        #expect(item.details.listPrice?.currency == .usd)
        #expect(item.listings.first?.statusDisplay.label == "Active (confirmed by eBay)")
        #expect(item.listings.first?.verification?.method == .marketplaceApi)
    }

    @Test func knownErrorCodesDecodeToTheTypedCode() async throws {
        let transport = StubTransport(
            status: .conflict,
            body: errorJSON(code: "version_conflict", retryable: false)
        )
        let client = Client(serverURL: try Servers.Server1.url(), transport: transport)

        let output = try await client.replaceItem(
            path: .init(itemId: "0b9d4e8a-1c2f-4a5b-8c7d-6e5f4a3b2c1d"),
            body: .json(.init(expectedVersion: 3, details: .init()))
        )

        let error = try output.conflict.body.json.error
        #expect(error.code.value1 == .versionConflict)
        #expect(error.retryable == false)
        #expect(error.message == "Something went wrong.")
    }

    @Test func unknownErrorCodesStillDecodeWithMessageAndRetryable() async throws {
        // A code added to the server after this client was built must not break decoding.
        let transport = StubTransport(
            status: .serviceUnavailable,
            body: errorJSON(code: "code_added_later", retryable: true)
        )
        let client = Client(serverURL: try Servers.Server1.url(), transport: transport)

        let output = try await client.getItem(path: .init(itemId: "0b9d4e8a-1c2f-4a5b-8c7d-6e5f4a3b2c1d"))

        guard case let .default(statusCode, response) = output else {
            Issue.record("expected the default error response, got \(output)")
            return
        }
        let error = try response.body.json.error
        #expect(statusCode == 503)
        #expect(error.code.value1 == nil)
        #expect(error.code.value2 == "code_added_later")
        #expect(error.retryable)
        #expect(error.retryAfterSeconds == 30)
    }

    @Test func unknownEnumValuesDecodeWithoutFailing() async throws {
        // A marketplace, status, tone, mode, or action added to the server after this client
        // was built must not break decoding of the listing (and so of every item).
        let transport = StubTransport(status: .ok, body: futureListingJSON)
        let client = Client(serverURL: try Servers.Server1.url(), transport: transport)

        let output = try await client.getListing(path: .init(listingId: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d"))

        let listing = try output.ok.body.json
        #expect(listing.marketplace.value1 == nil)
        #expect(listing.marketplace.value2 == "vinted")
        #expect(listing.mode.value2 == "partner_api")
        #expect(listing.status.value1 == nil)
        #expect(listing.status.value2 == "paused")
        #expect(listing.statusDisplay.tone.value1 == nil)
        #expect(listing.statusDisplay.label == "Paused on Vinted")
        #expect(listing.availableActions.map(\.action.value1) == [nil, .end])
        #expect(listing.availableActions.first?.action.value2 == "share")
    }

    @Test func unknownMarketplacesAndCapabilitiesKeepTheConnectionList() async throws {
        let transport = StubTransport(status: .ok, body: connectionsJSON)
        let client = Client(serverURL: try Servers.Server1.url(), transport: transport)

        let output = try await client.listConnections()

        let connections = try output.ok.body.json.data
        #expect(connections.map(\.marketplace.value2) == ["ebay", "vinted"])
        #expect(connections.first?.marketplace.value1 == .ebay)
        let future = try #require(connections.last)
        #expect(future.status.value2 == "waitlisted")
        #expect(future.capabilities.create.value1 == nil)
        #expect(future.capabilities.create.value2 == "partner_feed")
        #expect(future.capabilities.saleDetection.map(\.value1) == [.webhook, nil])
        #expect(future.availableActions.map(\.value1) == [nil, .connect])
        #expect(future.availableActions.first?.value2 == "join_waitlist")
    }

    @Test func bundleSaleDecodesItemsFeesAndProfit() async throws {
        let transport = StubTransport(status: .ok, body: bundleSaleJSON)
        let client = Client(serverURL: try Servers.Server1.url(), transport: transport)

        let output = try await client.getSale(path: .init(saleId: "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b"))

        let sale = try output.ok.body.json
        #expect(sale.items.count == 2)
        #expect(sale.items.first?.listingId == "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d")
        #expect(sale.items.last?.listingId == nil)
        #expect(sale.salePrice.amountCents == 6000)
        #expect(sale.fees?.map(\._type.value1) == [.marketplace, nil])
        #expect(sale.fees?.first?.source == .actual)
        #expect(sale.netProceeds?.amountCents == 5100)
        #expect(sale.profit?.amountCents == 3100)
        #expect(sale.shippingCost == nil)
        let run = try #require(sale.delistRuns.first)
        #expect(run.status == .needsAttention)
        #expect(run.escalated == false)
        #expect(run.results.map(\.state.value1) == [.delisted, nil])
        #expect(run.results.last?.state.value2 == "awaiting_runner")
        #expect(run.results.last?.userTaskId == "7c6e1f5b-8d9a-4b2c-9d4e-5f6a7b8c9d0e")
        #expect(sale.doubleSales.isEmpty)
    }

    @Test func readinessFailureDecodesAs503() async throws {
        let transport = StubTransport(
            status: .serviceUnavailable,
            body: #"{"status":"unavailable","checks":{"database":"unavailable"}}"#
        )
        let client = Client(serverURL: try Servers.Server1.url(), transport: transport)

        let output = try await client.getReadiness()

        let body = try output.serviceUnavailable.body.json
        #expect(body.status == .unavailable)
        #expect(body.checks.database == .unavailable)
    }
}

/// Answers every request with one canned JSON response and records the last request.
private actor StubTransport: ClientTransport {
    private let status: HTTPResponse.Status
    private let body: String
    private(set) var lastRequest: HTTPRequest?
    private(set) var lastBody: Data?

    init(status: HTTPResponse.Status, body: String) {
        self.status = status
        self.body = body
    }

    func send(
        _ request: HTTPRequest,
        body requestBody: HTTPBody?,
        baseURL: URL,
        operationID: String
    ) async throws -> (HTTPResponse, HTTPBody?) {
        lastRequest = request
        if let requestBody {
            lastBody = try await Data(collecting: requestBody, upTo: 1_000_000)
        }
        var response = HTTPResponse(status: status)
        response.headerFields[.contentType] = "application/json"
        return (response, HTTPBody(body))
    }
}

private func errorJSON(code: String, retryable: Bool) -> String {
    """
    {"error":{"code":"\(code)","message":"Something went wrong.","retryable":\(retryable),\
    "retryAfterSeconds":30,"requestId":"req-123"}}
    """
}

private let itemJSON = """
    {
      "id": "0b9d4e8a-1c2f-4a5b-8c7d-6e5f4a3b2c1d",
      "sku": "AJ-000184",
      "status": "draft",
      "version": 1,
      "details": {
        "title": "Vintage denim jacket",
        "listPrice": { "amountCents": 3400, "currency": "USD" },
        "storageLocationId": "3c2b1a0f-9e8d-4c7b-8a6f-5e4d3c2b1a0f"
      },
      "fieldProvenance": { "title": "user" },
      "storageLocation": { "id": "3c2b1a0f-9e8d-4c7b-8a6f-5e4d3c2b1a0f", "code": "B-12", "label": "Garage shelf 3, bin 12" },
      "photos": [],
      "listings": [
        {
          "id": "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
          "itemId": "0b9d4e8a-1c2f-4a5b-8c7d-6e5f4a3b2c1d",
          "marketplace": "ebay",
          "mode": "api",
          "status": "active",
          "statusDisplay": { "tone": "success", "label": "Active (confirmed by eBay)" },
          "verification": { "method": "marketplace_api", "verifiedAt": "2026-10-24T12:00:14Z" },
          "variant": {
            "title": "Levi's Vintage Denim Trucker Jacket Mens M Blue",
            "description": "Classic trucker jacket.",
            "price": { "amountCents": 3400, "currency": "USD" }
          },
          "availableActions": [{ "action": "end", "mode": "api" }],
          "createdAt": "2026-10-24T12:00:00Z",
          "updatedAt": "2026-10-24T12:00:14Z"
        }
      ],
      "createdAt": "2026-10-24T12:00:00Z",
      "updatedAt": "2026-10-24T12:00:00Z"
    }
    """

private let futureListingJSON = """
    {
      "id": "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
      "itemId": "0b9d4e8a-1c2f-4a5b-8c7d-6e5f4a3b2c1d",
      "marketplace": "vinted",
      "mode": "partner_api",
      "status": "paused",
      "statusDisplay": { "tone": "paused", "label": "Paused on Vinted" },
      "variant": {
        "title": "Levi's Vintage Denim Trucker Jacket Mens M Blue",
        "description": "Classic trucker jacket.",
        "price": { "amountCents": 3400, "currency": "USD" }
      },
      "availableActions": [{ "action": "share", "mode": "api" }, { "action": "end", "mode": "api" }],
      "createdAt": "2026-10-24T12:00:00Z",
      "updatedAt": "2026-10-24T12:00:14Z"
    }
    """

private let connectionsJSON = """
    {
      "data": [
        {
          "marketplace": "ebay",
          "mode": "api",
          "status": "connected",
          "statusDisplay": { "tone": "success", "label": "Connected" },
          "availableActions": [],
          "capabilities": {
            "connect": "oauth", "create": "api", "updatePrice": "api", "updateDetails": "api",
            "delist": "api", "relist": "api", "markSold": "not_needed", "verifyRead": "api",
            "importListings": "api", "saleDetection": ["webhook", "poll"], "imageTransport": "url_fetch"
          }
        },
        {
          "marketplace": "vinted",
          "mode": "assisted",
          "status": "waitlisted",
          "statusDisplay": { "tone": "neutral", "label": "Coming soon" },
          "availableActions": ["join_waitlist", "connect"],
          "capabilities": {
            "connect": "none", "create": "partner_feed", "updatePrice": "none", "updateDetails": "none",
            "delist": "assisted", "relist": "none", "markSold": "assisted", "verifyRead": "user_confirm",
            "importListings": "none", "saleDetection": ["webhook", "push"], "imageTransport": "user_saves_photos"
          }
        }
      ]
    }
    """

private let bundleSaleJSON = """
    {
      "id": "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b",
      "marketplace": "depop",
      "externalOrderId": "D-1001",
      "items": [
        {
          "itemId": "0b9d4e8a-1c2f-4a5b-8c7d-6e5f4a3b2c1d",
          "listingId": "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
          "salePrice": { "amountCents": 3400, "currency": "USD" }
        },
        {
          "itemId": "1c0e5f9b-2d3a-4b6c-9d8e-7f6a5b4c3d2e",
          "salePrice": { "amountCents": 2600, "currency": "USD" }
        }
      ],
      "soldAt": "2026-10-24T13:00:00Z",
      "salePrice": { "amountCents": 6000, "currency": "USD" },
      "fees": [
        { "type": "marketplace", "amount": { "amountCents": 600, "currency": "USD" }, "source": "actual" },
        { "type": "boost", "amount": { "amountCents": 300, "currency": "USD" }, "source": "estimated" }
      ],
      "netProceeds": { "amountCents": 5100, "currency": "USD" },
      "profit": { "amountCents": 3100, "currency": "USD" },
      "detectionSource": "webhook",
      "status": "detected",
      "isDoubleSale": false,
      "delistRuns": [
        {
          "id": "2d1f6a0c-3e4b-4c7d-8e9f-0a1b2c3d4e5f",
          "saleId": "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b",
          "itemId": "0b9d4e8a-1c2f-4a5b-8c7d-6e5f4a3b2c1d",
          "soldOn": "depop",
          "status": "needs_attention",
          "statusDisplay": { "tone": "action_needed", "label": "Action needed - delist on Poshmark" },
          "results": [
            {
              "listingId": "3e2a7b1d-4f5c-4d8e-9f0a-1b2c3d4e5f6a",
              "marketplace": "ebay",
              "mode": "api",
              "state": "delisted",
              "statusDisplay": { "tone": "success", "label": "Delisted (confirmed by eBay)" },
              "operationId": "4f3b8c2e-5a6d-4e9f-8a1b-2c3d4e5f6a7b",
              "attempt": 1,
              "maxAttempts": 7,
              "updatedAt": "2026-10-24T13:00:20Z"
            },
            {
              "listingId": "5a4c9d3f-6b7e-4f0a-9b2c-3d4e5f6a7b8c",
              "marketplace": "poshmark",
              "mode": "assisted",
              "state": "awaiting_runner",
              "statusDisplay": { "tone": "action_needed", "label": "Action needed - delist on Poshmark" },
              "operationId": "6b5d0e4a-7c8f-4a1b-8c3d-4e5f6a7b8c9d",
              "attempt": 1,
              "maxAttempts": 7,
              "userTaskId": "7c6e1f5b-8d9a-4b2c-9d4e-5f6a7b8c9d0e",
              "updatedAt": "2026-10-24T13:00:06Z"
            }
          ],
          "escalated": false,
          "startedAt": "2026-10-24T13:00:05Z"
        }
      ],
      "doubleSales": [],
      "createdAt": "2026-10-24T13:00:05Z",
      "updatedAt": "2026-10-24T13:00:05Z"
    }
    """
