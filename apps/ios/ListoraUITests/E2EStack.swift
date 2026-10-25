import XCTest

/// The local stack's API and signed-in session, from xcodebuild's `TEST_RUNNER_` variables.
struct E2EStack {
    let apiURL: URL
    let token: String
    let email: String
    /// The stack's control endpoint (packages/e2e/src/control.ts).
    let controlURL: URL?

    static func fromEnvironment() throws -> E2EStack {
        let environment = ProcessInfo.processInfo.environment
        guard let url = environment["LISTORA_E2E_API_BASE_URL"].flatMap(URL.init(string:)),
              let token = environment["LISTORA_E2E_ACCESS_TOKEN"]
        else {
            throw XCTSkip("Needs the local stack. Run `make ios-test`, which starts it.")
        }
        return E2EStack(
            apiURL: url,
            token: token,
            email: environment["LISTORA_E2E_EMAIL"] ?? "e2e@listora.test",
            controlURL: environment["LISTORA_E2E_CONTROL_URL"].flatMap(URL.init(string:)),
        )
    }

    /// The item as the API has it (`getItemBySku`).
    func item(sku: String) async throws -> SavedItem {
        var request = URLRequest(url: apiURL.appending(path: "v1/skus/\(sku)"))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(SavedItem.self, from: data)
    }

    /// A ready-to-list item with processed photos, made through the API (`POST /items`).
    func seedReadyItem() async throws -> SeededItem {
        let data = try await control("items", method: "POST", body: [:])
        return try JSONDecoder().decode(SeededItem.self, from: data)
    }

    /// A ready item already live on eBay, confirmed by the fake eBay (`POST /items/listed`).
    func seedListedItem() async throws -> SeededItem {
        let data = try await control("items/listed", method: "POST", body: [:])
        return try JSONDecoder().decode(SeededItem.self, from: data)
    }

    /// Makes the fake eBay fail the next matching request (`POST /ebay/faults`).
    func injectEbayFault(action: String, type: String, message: String? = nil) async throws {
        var fault: [String: Any] = ["type": type]
        fault["message"] = message
        _ = try await control("ebay/faults", method: "POST", body: ["action": action, "fault": fault])
    }

    /// Removes every fault a test injected (`DELETE /ebay/faults`), so a test never inherits one.
    func clearEbayFaults() async throws {
        _ = try await control("ebay/faults", method: "DELETE", body: nil)
    }

    private func control(_ path: String, method: String, body: [String: Any]?) async throws -> Data {
        let base = try XCTUnwrap(controlURL, "the local stack has no control endpoint")
        var request = URLRequest(url: base.appending(path: path))
        request.httpMethod = method
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        XCTAssertTrue((200 ..< 300).contains(status), String(bytes: data, encoding: .utf8) ?? "")
        return data
    }
}

struct SeededItem: Decodable {
    let id: String
    let sku: String
}

/// The parts of the contract's `Item` the test checks.
struct SavedItem: Decodable {
    let status: String
    let details: SavedDetails
    let fieldProvenance: [String: String]
}

struct SavedDetails: Decodable {
    let listPrice: SavedMoney?
    let floorPrice: SavedMoney?
    let cost: SavedMoney?
    let purchaseSource: String?
    let colors: [String]?
}

struct SavedMoney: Decodable {
    let amountCents: Int
}
