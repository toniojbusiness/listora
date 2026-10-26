import XCTest

/// The full local stack (`make e2e-full`, `--marketplaces all`; docs/features/e2e.md): every
/// marketplace on its fake. The seller has eBay and Depop connected through their APIs and links
/// Poshmark and Mercari on this phone; a second seller's eBay is automated in the cloud.
struct FullStack {
    let stack: E2EStack
    /// The second seller's session token and email.
    let secondToken: String
    let secondEmail: String

    /// The full stack, or a skip: the full-stack suite runs only under `make e2e-full`.
    static func fromEnvironment() throws -> FullStack {
        let stack = try E2EStack.fromEnvironment()
        let environment = ProcessInfo.processInfo.environment
        guard environment["LISTORA_E2E_MARKETPLACES"] == "all",
              let secondToken = environment["LISTORA_E2E_SECOND_ACCESS_TOKEN"]
        else {
            throw XCTSkip("Needs the full local stack. Run `make e2e-full`, which starts it.")
        }
        return FullStack(
            stack: stack,
            secondToken: secondToken,
            secondEmail: environment["LISTORA_E2E_SECOND_EMAIL"] ?? "e2e-second@listora.test",
        )
    }

    /// The newest one-time code the API's dev sign-in printed for `email`, as their email would
    /// show it (`GET /dev/sign-in-code`).
    func signInCode(for email: String) async throws -> String {
        let data = try await control("dev/sign-in-code", method: "GET", query: ["email": email])
        return try JSONDecoder().decode(SignInCode.self, from: data).code
    }

    /// A ready item for a seller (`primary` or `second`), with details replaced key by key.
    func seedReadyItem(seller: String, details: [String: String]) async throws -> SeededItem {
        let data = try await control("items", method: "POST", body: ["seller": seller, "details": details])
        return try JSONDecoder().decode(SeededItem.self, from: data)
    }

    /// An item published on each marketplace (`POST /items/listed`). Its Poshmark and Mercari
    /// listings run on this phone, so the stack does not wait for them: the test waits on the
    /// item screen while the app runs them.
    func seedListedItem(
        seller: String = "primary",
        on marketplaces: [String],
        details: [String: String],
    ) async throws -> SeededItem {
        let data = try await control(
            "items/listed",
            method: "POST",
            body: ["seller": seller, "marketplaces": marketplaces, "details": details, "wait": false],
        )
        return try JSONDecoder().decode(SeededItem.self, from: data)
    }

    /// A buyer buys the item's eBay listing; the fake eBay sends the API its notification.
    func sellOnEbay(sku: String) async throws {
        _ = try await control("ebay/sales", method: "POST", body: ["sku": sku])
    }

    /// The fake Poshmark, Mercari, or eBay site fails the next matching page
    /// (`POST /automation/faults`): a `captcha`, a `reject` with a message, a `server_error`.
    func injectSiteFault(
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

    /// Links a fresh eBay session for the second seller (`POST /sessions/ebay`), as relinking does.
    func linkSecondSellersEbay() async throws {
        _ = try await control("sessions/ebay", method: "POST", body: [:])
    }

    private func control(
        _ path: String,
        method: String,
        body: [String: Any]? = nil,
        query: [String: String] = [:],
    ) async throws -> Data {
        let base = try XCTUnwrap(stack.controlURL, "the local stack has no control endpoint")
        var url = base.appending(path: path)
        if !query.isEmpty {
            url.append(queryItems: query.map { URLQueryItem(name: $0.key, value: $0.value) })
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        // Seeding processes photos and waits for the API marketplaces' read-backs.
        request.timeoutInterval = 180
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        XCTAssertTrue((200 ..< 300).contains(status), String(bytes: data, encoding: .utf8) ?? "")
        return data
    }
}

private struct SignInCode: Decodable {
    let code: String
}
