import XCTest

/// The local stack's API and signed-in session, from xcodebuild's `TEST_RUNNER_` variables.
struct E2EStack {
    let apiURL: URL
    let token: String
    let email: String
    /// The stack's control endpoint (packages/e2e/src/control.ts).
    let controlURL: URL?
    /// `ebay`, or `all` for the full stack (`make e2e-full`): Depop through its API, Poshmark and
    /// Mercari automated in linked sessions, and a second seller whose Depop is automated.
    let marketplaces: String
    /// The full stack's second seller (its token and email).
    let secondSeller: (token: String, email: String)?

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
            marketplaces: environment["LISTORA_E2E_MARKETPLACES"] ?? "ebay",
            secondSeller: environment["LISTORA_E2E_SECOND_ACCESS_TOKEN"].map { token in
                (token, environment["LISTORA_E2E_SECOND_EMAIL"] ?? "e2e-second@listora.test")
            },
        )
    }

    /// The full stack, or a skip: the full-stack suite runs only under `make e2e-full`.
    static func fullFromEnvironment() throws -> E2EStack {
        let stack = try fromEnvironment()
        guard stack.marketplaces == "all", stack.secondSeller != nil else {
            throw XCTSkip("Needs the full local stack. Run `make e2e-full`, which starts it.")
        }
        return stack
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

    /// Records a sale of one item by hand through the API (`createSale`, "Mark as sold").
    func recordSale(itemID: String, marketplace: String, priceCents: Int) async throws {
        var request = URLRequest(url: apiURL.appending(path: "v1/sales"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "marketplace": marketplace,
            "items": [["itemId": itemID, "salePrice": ["amountCents": priceCents, "currency": "USD"]]],
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 201, String(bytes: data, encoding: .utf8) ?? "")
    }

    /// The profit dashboard's summary as the API reports it (`getProfit`).
    func profitSummary(firstDay: String, lastDay: String, timeZone: String) async throws -> ProfitSummary {
        var components = URLComponents(url: apiURL.appending(path: "v1/profit"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "from", value: firstDay),
            URLQueryItem(name: "to", value: lastDay),
            URLQueryItem(name: "timeZone", value: timeZone),
        ]
        var request = try URLRequest(url: XCTUnwrap(components?.url))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, String(bytes: data, encoding: .utf8) ?? "")
        return try JSONDecoder().decode(ProfitReportBody.self, from: data).summary
    }

    /// Makes the fake eBay fail the next matching request (`POST /ebay/faults`).
    func injectEbayFault(action: String, type: String, message: String? = nil) async throws {
        var fault: [String: Any] = ["type": type]
        fault["message"] = message
        _ = try await control("ebay/faults", method: "POST", body: ["action": action, "fault": fault])
    }

    /// Puts the user's eBay connection in a health state as the daily check records it
    /// (`POST /connections/ebay`): `degraded`, `reauth_required`, or back to `connected`.
    func setEbayConnection(_ status: String) async throws {
        _ = try await control("connections/ebay", method: "POST", body: ["status": status])
    }

    /// Removes every fault a test injected (`DELETE /ebay/faults`), so a test never inherits one.
    func clearEbayFaults() async throws {
        _ = try await control("ebay/faults", method: "DELETE", body: nil)
    }

    // MARK: The full stack (`make e2e-full`)

    /// A ready item for a seller (`primary` or `second`), with details replaced key by key.
    func seedReadyItem(seller: String, details: [String: String]) async throws -> SeededItem {
        let data = try await control("items", method: "POST", body: ["seller": seller, "details": details])
        return try JSONDecoder().decode(SeededItem.self, from: data)
    }

    /// An item live on each marketplace, every listing confirmed by its read-back.
    func seedListedItem(on marketplaces: [String], details: [String: String]) async throws -> SeededItem {
        let data = try await control(
            "items/listed",
            method: "POST",
            body: ["marketplaces": marketplaces, "details": details],
        )
        return try JSONDecoder().decode(SeededItem.self, from: data)
    }

    /// A buyer buys the item's eBay listing; the fake eBay sends the API its notification.
    func sellOnEbay(sku: String) async throws {
        _ = try await control("ebay/sales", method: "POST", body: ["sku": sku])
    }

    /// The fake Poshmark, Mercari, or Depop site fails the next matching page
    /// (`POST /automation/faults`): a `captcha`, a `reject` with a message, a `server_error`.
    func injectAutomationFault(
        marketplace: String,
        action: String,
        type: String,
        message: String? = nil,
        times: Int = 1,
    ) async throws {
        var fault: [String: Any] = ["type": type]
        fault["message"] = message
        _ = try await control(
            "automation/faults",
            method: "POST",
            body: ["marketplace": marketplace, "action": action, "fault": fault, "times": times],
        )
    }

    /// Removes every fault of every fake (`DELETE /faults`).
    func clearAllFaults() async throws {
        _ = try await control("faults", method: "DELETE", body: nil)
    }

    /// Links a fresh browser session (`POST /sessions/<marketplace>`), as relinking does.
    func linkSession(_ marketplace: String) async throws {
        _ = try await control("sessions/\(marketplace)", method: "POST", body: [:])
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

/// The parts of the contract's `ProfitReport` the test checks.
struct ProfitReportBody: Decodable {
    let summary: ProfitSummary
}

struct ProfitSummary: Decodable {
    let netProfit: SavedMoney
    let revenue: SavedMoney
    let salesCount: Int
}
