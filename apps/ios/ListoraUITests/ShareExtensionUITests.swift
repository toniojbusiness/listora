import XCTest

/// Shares a Poshmark listing link from Safari to the Listora Share Extension and links it to an
/// item, against `StubAPIServer`. Safari opens a local page that shares the link with the Web
/// Share API, so no marketplace page is ever loaded.
@MainActor
final class ShareExtensionUITests: XCTestCase {
    private let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
    private var server: StubAPIServer?

    override func setUp() async throws {
        continueAfterFailure = false
    }

    override func tearDown() async throws {
        server?.stop()
        safari.terminate()
    }

    /// Keeps a screenshot of the extension in the test results, for reviewing its screens.
    private func snapshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Launches the app once so it hands the Share Extension a session and the stub API.
    private func launchApp(environment: [String: String]) {
        let app = XCUIApplication()
        app.launchEnvironment = environment
        app.launch()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 10))
    }

    private func startServer() throws -> StubAPIServer {
        let server = try StubAPIServer()
        try server.start()
        self.server = server
        return server
    }

    /// Opens the share page in Safari, taps its share button, and picks Listora in the share sheet.
    private func shareFromSafari(server: StubAPIServer) throws {
        let page = try XCTUnwrap(URL(string: server.baseURL + StubAPIServer.sharePagePath))
        XCUIDevice.shared.system.open(page)
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 15), "Safari did not open")

        let share = safari.webViews.buttons["Share listing"]
        XCTAssertTrue(share.waitForExistence(timeout: 20), "the share page did not load\n\(safari.debugDescription)")
        let listora = safari.descendants(matching: .any)["Listora Dev"].firstMatch
        // A tap that lands while the page is still settling may not open the share sheet.
        for _ in 0 ..< 3 where !listora.exists {
            share.tap()
            _ = listora.waitForExistence(timeout: 10)
        }
        XCTAssertTrue(listora.exists, "Listora is not in the share sheet\n\(safari.debugDescription)")
        listora.tap()
    }

    func testLinksAListingSharedFromSafariToAnItem() throws {
        let server = try startServer()
        launchApp(environment: [
            "LISTORA_DEV_ACCESS_TOKEN": "ui-test-token",
            "LISTORA_DEV_API_BASE_URL": server.baseURL,
        ])
        try shareFromSafari(server: server)

        // The extension shows what it read from the shared link, and nothing else.
        let listing = safari.descendants(matching: .any)["share.listing"].firstMatch
        XCTAssertTrue(listing.waitForExistence(timeout: 15), "the extension did not open\n\(safari.debugDescription)")
        XCTAssertTrue(listing.label.contains("Poshmark listing"), listing.label)
        XCTAssertTrue(listing.label.contains("64f1a2b3c4d5e6f7a8b9c0d1"), listing.label)

        let item = safari.buttons["share.item.AJ-000184"]
        XCTAssertTrue(item.waitForExistence(timeout: 10), "no search result\n\(safari.debugDescription)")
        snapshot("1-choose")
        item.tap()

        let confirm = safari.buttons["share.confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        XCTAssertTrue(safari.staticTexts["Link to AJ-000184?"].exists)
        // Nothing is recorded until the user confirms.
        XCTAssertFalse(server.requests.contains { $0.method == "POST" })
        snapshot("2-confirm")
        confirm.tap()

        let status = safari.descendants(matching: .any)["share.status"].firstMatch
        XCTAssertTrue(status.waitForExistence(timeout: 10), "not linked\n\(safari.debugDescription)")
        XCTAssertEqual(status.label, "Poshmark: Active (you confirmed)")
        XCTAssertFalse(status.label.localizedCaseInsensitiveContains("confirmed by"))
        snapshot("3-linked")

        let link = try XCTUnwrap(server.requests.first { $0.method == "POST" })
        XCTAssertEqual(link.path, "/v1/items/\(StubAPIServer.itemId)/listing-links")
        XCTAssertEqual(link.headers["authorization"], "Bearer ui-test-token")
        XCTAssertNotNil(link.headers["idempotency-key"])
        // The canonical URL: the share's tracking query is not sent.
        XCTAssertTrue(link.body.contains("Lululemon-Align-Pant-25-64f1a2b3c4d5e6f7a8b9c0d1\""), link.body)
        XCTAssertFalse(link.body.contains("utm_source"), link.body)

        safari.buttons["Done"].firstMatch.tap()
        XCTAssertTrue(safari.webViews.buttons["Share listing"].waitForExistence(timeout: 10))
    }

    func testAsksToSignInWhenTheAppHasNoSession() throws {
        let server = try startServer()
        launchApp(environment: [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": server.baseURL,
        ])
        try shareFromSafari(server: server)

        XCTAssertTrue(
            safari.staticTexts["Sign in to Listora"].waitForExistence(timeout: 15),
            "no sign-in prompt\n\(safari.debugDescription)",
        )
        snapshot("signed-out")
        XCTAssertFalse(
            server.requests.contains { $0.path.hasPrefix("/v1/") },
            "the extension called the API signed out",
        )
        safari.buttons["Cancel"].firstMatch.tap()
    }
}
