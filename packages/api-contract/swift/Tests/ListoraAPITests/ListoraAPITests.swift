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
        #expect(item.status == .draft)
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
        "fieldProvenance": { "title": "user" }
      },
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
