import XCTest

/// The inventory, item screen, and eBay listing flow against the real API and worker with the
/// fake eBay: the local stack `make ios-test` starts (packages/e2e), which connects the test
/// user's eBay account through the fake's consent page and seeds items through its control
/// endpoint. Every status the test waits for is the server's own label: the app shows "Active
/// (confirmed by eBay)" only after the operation engine read the listing back from eBay.
@MainActor
final class ListingFlowUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testPublishChangePriceFailedDelistRetryAndDelist() async throws {
        let stack = try E2EStack.fromEnvironment()
        try await stack.clearEbayFaults()
        let item = try await stack.seedReadyItem()
        launch(signedInTo: stack)

        // The inventory lists the new item with its SKU.
        let row = app.buttons["inventory.row.\(item.sku)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "the seeded item is not in the inventory")
        keepScreenshot("Inventory")
        row.tap()

        let status = app.descendants(matching: .any)["marketplace.ebay.status"]
        publishOnEbay(status: status)
        // Publish: in progress, then confirmed by eBay's read-back.
        XCTAssertTrue(waitForLabel(of: status, "Active (confirmed by eBay)", timeout: 60), status.label)
        keepScreenshot("Active")

        let end = changePrice(status: status)
        // eBay refuses the delist: the failure is shown, with Retry.
        try await stack.injectEbayFault(action: "end", type: "reject", message: "The listing cannot be ended now.")
        end.tap()
        let endButton = app.buttons["End: no longer available"].firstMatch
        XCTAssertTrue(endButton.waitForExistence(timeout: 5))
        endButton.tap()
        XCTAssertTrue(waitForLabel(of: status, "Delist failed - Retry", timeout: 60), status.label)
        keepScreenshot("Delist failed")

        // Retry works: eBay ends it, and the app says so only once eBay confirms.
        app.buttons["marketplace.ebay.action.retry"].tap()
        XCTAssertTrue(waitForLabel(of: status, "Delisted (confirmed by eBay)", timeout: 60), status.label)
        XCTAssertTrue(app.buttons["marketplace.ebay.action.relist"].waitForExistence(timeout: 5))
        keepScreenshot("Delisted")

        // Back in the inventory the row shows the same status.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        XCTAssertTrue(waitForLabel(of: row, "Levi's Trucker Denim Jacket", timeout: 10, contains: true))
        XCTAssertTrue(row.label.contains("Delisted (confirmed by eBay)"), row.label)
    }

    func testSearchFindsAnItemBySKU() async throws {
        let stack = try E2EStack.fromEnvironment()
        let first = try await stack.seedReadyItem()
        let second = try await stack.seedReadyItem()
        launch(signedInTo: stack)
        XCTAssertTrue(app.buttons["inventory.row.\(second.sku)"].waitForExistence(timeout: 15))

        let search = app.searchFields.firstMatch
        search.tap()
        search.typeText(first.sku)
        XCTAssertTrue(waitForAbsence(of: app.buttons["inventory.row.\(second.sku)"]))
        XCTAssertTrue(app.buttons["inventory.row.\(first.sku)"].exists)
    }

    // MARK: Steps

    /// Not on eBay yet; List opens the marketplace choice, then the eBay version, then publishes.
    private func publishOnEbay(status: XCUIElement) {
        XCTAssertTrue(waitForLabel(of: status, "Not listed", timeout: 15), status.label)
        XCTAssertTrue(app.descendants(matching: .any)["item.cost"].exists)
        keepScreenshot("Item")
        app.buttons["marketplace.ebay.action.list"].tap()
        let next = app.buttons["listing.next"]
        XCTAssertTrue(next.waitForExistence(timeout: 10))
        XCTAssertTrue(waitForEnabled(next), "eBay is not offered")
        keepScreenshot("Choose marketplaces")
        next.tap()
        let title = app.textFields["listing.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.value as? String, "Levi's Trucker Denim Jacket")
        keepScreenshot("eBay listing")
        app.buttons["listing.publish"].tap()
    }

    /// A price change to $39, confirmed by eBay. Returns the End button, back once it settled.
    private func changePrice(status: XCUIElement) -> XCUIElement {
        app.buttons["marketplace.ebay.action.changePrice"].tap()
        let price = app.textFields["New price"]
        XCTAssertTrue(price.waitForExistence(timeout: 5))
        price.tap()
        price.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 6) + "39")
        app.buttons["price.save"].tap()
        // The label reads "Active (confirmed by eBay)" before the change is queued too, so wait
        // for the change in the history and its actions coming back, which happens only once it
        // is settled; then the label must still be the confirmed one.
        let history = app.descendants(matching: .any)["marketplace.ebay.history"]
        XCTAssertTrue(waitForLabel(of: history, "History (2)", timeout: 30), history.label)
        let end = app.buttons["marketplace.ebay.action.end"]
        XCTAssertTrue(end.waitForExistence(timeout: 60), "the price change never settled: \(status.label)")
        XCTAssertEqual(status.label, "Active (confirmed by eBay)")
        XCTAssertEqual(app.descendants(matching: .any)["marketplace.ebay.price"].label, "Listed at $39.00")
        return end
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

    private func waitForLabel(
        of element: XCUIElement,
        _ label: String,
        timeout: TimeInterval,
        contains: Bool = false,
    ) -> Bool {
        let predicate = NSPredicate(format: contains ? "label CONTAINS %@" : "label == %@", label)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }

    private func waitForEnabled(_ element: XCUIElement, timeout: TimeInterval = 10) -> Bool {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"),
            object: element,
        )
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }

    private func waitForAbsence(of element: XCUIElement, timeout: TimeInterval = 10) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }
}
