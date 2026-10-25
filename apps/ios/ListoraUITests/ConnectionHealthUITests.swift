import XCTest

/// The connection health dashboard against the real API and worker with the fake eBay (the
/// local stack `make ios-test` starts): the app banner while eBay needs attention, the
/// Marketplaces cards in the server's words, and Retry check, which the worker runs against the
/// fake eBay. Every status the test waits for is the server's own label.
@MainActor
final class ConnectionHealthUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testBannerOpensMarketplacesAndRetryCheckReconnects() async throws {
        let stack = try E2EStack.fromEnvironment()
        // The other UI tests list on eBay: always leave it connected.
        addTeardownBlock { try await stack.setEbayConnection("connected") }
        try await stack.setEbayConnection("reauth_required")
        launch(signedInTo: stack)

        // Inventory shows the banner in the server's words, and Settings has a badge.
        let banner = app.descendants(matching: .any)["connectionAttention.banner"]
        XCTAssertTrue(banner.waitForExistence(timeout: 15), "no connection banner")
        XCTAssertTrue(banner.label.contains("Reconnect eBay"), banner.label)
        keepScreenshot("Inventory with the connection banner")
        app.buttons["connectionAttention.open"].tap()

        // The banner opens Marketplaces: one card per marketplace, with mode, status, and action.
        XCTAssertTrue(app.navigationBars["Marketplaces"].waitForExistence(timeout: 5))
        let ebay = app.descendants(matching: .any)["marketplaces.ebay.status"]
        XCTAssertTrue(waitForLabel(of: ebay, "Reconnect needed", timeout: 10), ebay.label)
        XCTAssertEqual(app.buttons["marketplaces.ebay.connect"].label, "Reconnect eBay")
        XCTAssertEqual(app.descendants(matching: .any)["marketplaces.ebay.mode"].label, "API mode")
        XCTAssertEqual(app.descendants(matching: .any)["marketplaces.poshmark.status"].label, "Not linked")
        XCTAssertEqual(app.descendants(matching: .any)["marketplaces.poshmark.mode"].label, "Assisted mode")
        keepScreenshot("Marketplaces, eBay needs reconnecting")

        // Listora could not reach eBay instead: Retry check asks the worker, which finds it working.
        try await stack.setEbayConnection("degraded")
        // Marketplaces reads the server again each time it opens.
        app.navigationBars["Marketplaces"].buttons.element(boundBy: 0).tap()
        app.buttons["settings.marketplaces"].tap()
        XCTAssertTrue(app.navigationBars["Marketplaces"].waitForExistence(timeout: 5))
        XCTAssertTrue(waitForLabel(of: ebay, "Connection problem", timeout: 10), ebay.label)
        let forwarding = app.descendants(matching: .any)["marketplaces.saleForwarding.status"]
        XCTAssertTrue(forwarding.waitForExistence(timeout: 5))
        XCTAssertEqual(forwarding.label, "Set up when you add a domain")
        let check = app.buttons["marketplaces.ebay.check"]
        XCTAssertTrue(check.waitForExistence(timeout: 5))
        XCTAssertEqual(check.label, "Retry check")
        keepScreenshot("Marketplaces, eBay connection problem")
        check.tap()
        XCTAssertTrue(waitForLabel(of: ebay, "Connected", timeout: 30), ebay.label)
        XCTAssertTrue(app.descendants(matching: .any)["marketplaces.ebay.lastOk"].exists)
        XCTAssertFalse(check.exists)
        keepScreenshot("Marketplaces, eBay connected")

        // Back on Inventory the banner is gone.
        app.tabBars.buttons["Inventory"].tap()
        XCTAssertTrue(waitForAbsence(of: banner), "the banner stayed after eBay was fixed")
    }

    private func launch(signedInTo stack: E2EStack) {
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": stack.token,
            "LISTORA_DEV_ACCESS_EMAIL": stack.email,
        ]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Inventory"].waitForExistence(timeout: 10))
    }

    /// Keeps a screenshot in the result bundle, passing or not, for reviewing the screens.
    private func keepScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func waitForLabel(of element: XCUIElement, _ label: String, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "label == %@", label)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }

    private func waitForAbsence(of element: XCUIElement, timeout: TimeInterval = 10) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }
}
