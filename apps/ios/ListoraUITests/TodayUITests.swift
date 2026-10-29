import XCTest

/// The Today tab, the app's home: its cards, each card's one action, finished work dropping off,
/// the calm all-caught-up state, and the morning summary setting.
@MainActor
final class TodayUITests: XCTestCase {
    private let app = XCUIApplication()
    private var server: StubAPIServer?

    override func setUp() async throws {
        continueAfterFailure = false
    }

    override func tearDown() async throws {
        server?.stop()
    }

    /// Against the stub, which answers a card of every kind: each action opens its screen, and once
    /// the work is done the screen says the seller is all caught up.
    func testCardsOpenTheirScreensAndTheDayEndsCaughtUp() throws {
        let server = try StubAPIServer()
        try server.start()
        self.server = server
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": server.baseURL,
            "LISTORA_DEV_ACCESS_TOKEN": "stub-token",
        ]
        app.launchQuietly()

        // Today is the first tab and opens first, most urgent card on top.
        XCTAssertTrue(app.tabRail.buttons["Today"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.tabRail.buttons["Today"].isSelected)
        let ship = card(StubAPIServer.shipCardID)
        XCTAssertTrue(ship.waitForExistence(timeout: 10), "no ship card")
        XCTAssertTrue(app.staticTexts["3 things need you"].exists)
        XCTAssertTrue(ship.staticTexts["Ship Lululemon Align pant"].exists)
        XCTAssertTrue(ship.staticTexts["Urgent"].exists)
        XCTAssertTrue(ship.staticTexts["B-12 · Garage shelf 3"].exists)
        XCTAssertTrue(
            ship.staticTexts["Ship by today"].exists || ship.staticTexts["Ship by tomorrow"].exists,
            "no ship-by date on the card",
        )
        XCTAssertTrue(card(StubAPIServer.reconnectCardID).exists)
        keepScreenshot("Today")

        // Reconnect opens the marketplace connections.
        action(StubAPIServer.reconnectCardID).tap()
        XCTAssertTrue(app.navigationBars["Marketplaces"].waitForExistence(timeout: 5))
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // The drafts card opens the drafts: this iPhone has none, so the server's, in Inventory.
        let drafts = action(StubAPIServer.draftsCardID)
        scroll(to: drafts)
        drafts.tap()
        XCTAssertTrue(app.navigationBars["Inventory"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.tabRail.buttons["Inventory"].isSelected)

        // The money summary: this week next to last week, and the profit the server knows.
        app.tabRail.buttons["Today"].tap()
        let sales = app.descendants(matching: .any)["today.money.sales"]
        scroll(to: sales)
        XCTAssertTrue(sales.label.contains("$142"), sales.label)
        XCTAssertTrue(sales.label.contains("$44 more than last week"), sales.label)
        let profit = app.descendants(matching: .any)["today.money.profit"]
        XCTAssertTrue(profit.label.contains("$61.50"), profit.label)
        XCTAssertTrue(profit.label.contains("Not counting 1 sale"), profit.label)

        // Everything is done: the next look at Today is all caught up.
        server.setToday(.caughtUp)
        app.tabRail.buttons["Inventory"].tap()
        app.tabRail.buttons["Today"].tap()
        XCTAssertTrue(app.staticTexts["You're all caught up"].waitForExistence(timeout: 10))
        XCTAssertFalse(card(StubAPIServer.shipCardID).exists)
        keepScreenshot("All caught up")
    }

    /// The morning summary setting saves the seller's time with this device's time zone.
    func testTheMorningSummarySettingSavesWithTheDeviceTimeZone() throws {
        let server = try StubAPIServer()
        try server.start()
        self.server = server
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": server.baseURL,
            "LISTORA_DEV_ACCESS_TOKEN": "stub-token",
        ]
        app.launchQuietly()
        let bell = app.buttons["today.summarySettings"]
        XCTAssertTrue(bell.waitForExistence(timeout: 10))
        bell.tap()
        let enabled = app.switches["summarySettings.enabled"]
        XCTAssertTrue(enabled.waitForExistence(timeout: 5))
        XCTAssertEqual(enabled.value as? String, "1")
        // The switch's own control, not its label.
        enabled.switches.firstMatch.tap()
        keepScreenshot("Morning summary")
        app.buttons["summarySettings.save"].tap()
        XCTAssertTrue(enabled.waitForNonExistence(timeout: 5), "the sheet did not close after saving")

        let saved = server.requests.last { $0.method == "PUT" && $0.path == "/v1/today/settings" }
        let body = try XCTUnwrap(saved?.body)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any])
        XCTAssertEqual(json["enabled"] as? Bool, false)
        XCTAssertEqual(json["time"] as? String, "08:00")
        XCTAssertEqual(json["timeZone"] as? String, TimeZone.current.identifier)
    }

    /// Against the local stack (the real API computing the card): a sold item's ship card opens
    /// its sale, and once the seller marks it shipped there the card is gone.
    func testAShipCardOpensTheSaleAndLeavesOnceShipped() async throws {
        let stack = try E2EStack.fromEnvironment()
        let sold = try await stack.seedSoldItem()
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": stack.token,
            "LISTORA_DEV_ACCESS_EMAIL": stack.email,
        ]
        app.launchQuietly()

        let id = "ship:\(sold.saleItemId)"
        let ship = card(id)
        XCTAssertTrue(ship.waitForExistence(timeout: 15), "no ship card for the sold item")
        XCTAssertTrue(ship.staticTexts["Ship Wrangler Western Shirt"].exists)
        XCTAssertTrue(ship.staticTexts["B-12 · Garage shelf 3"].exists)
        keepScreenshot("Ship card")

        let open = action(id)
        scroll(to: open)
        XCTAssertEqual(open.label, "Open sale")
        open.tap()
        XCTAssertTrue(app.navigationBars["Sale"].waitForExistence(timeout: 10), "the sale did not open")

        // Mark shipped on the sale screen, as the seller would.
        let markShipped = app.buttons["sale.action.markShipped"]
        XCTAssertTrue(markShipped.waitForExistence(timeout: 10))
        markShipped.tap()
        let save = app.buttons["ship.save"]
        XCTAssertTrue(save.waitForExistence(timeout: 5))
        save.tap()
        XCTAssertTrue(save.waitForNonExistence(timeout: 10))
        let status = app.descendants(matching: .any)["sale.status"]
        let shipped = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label CONTAINS 'Shipped'"),
            object: status,
        )
        XCTAssertEqual(XCTWaiter().wait(for: [shipped], timeout: 15), .completed, status.label)

        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(ship.waitForNonExistence(timeout: 10), "the shipped sale's card is still there")
    }

    // MARK: Helpers

    private func card(_ id: String) -> XCUIElement {
        app.descendants(matching: .any)["today.card.\(id)"]
    }

    private func action(_ id: String) -> XCUIElement {
        app.buttons["today.action.\(id)"]
    }

    /// Scrolls the screen until `element` is on it.
    private func scroll(to element: XCUIElement) {
        for _ in 0 ..< 6 where !element.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(element.isHittable, "\(element) is not on screen")
    }

    /// Keeps a screenshot in the result bundle, passing or not, for reviewing the screens.
    private func keepScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
