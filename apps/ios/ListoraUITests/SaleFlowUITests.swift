import XCTest

/// "Mark as sold" and the sale lifecycle against the real API and worker with the fake eBay (the
/// local stack `make ios-test` starts). An item live on eBay is marked sold on Depop: the app
/// shows the sale's estimated fees and profit, and eBay's delist only once the server confirmed
/// it on eBay. Canceling the sale relists nothing until the seller chooses, and the relist on
/// eBay shows as live only once eBay confirms it.
@MainActor
final class SaleFlowUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testMarkSoldDelistsCancelAsksAndRelistsOnlyWhereChosen() async throws {
        let stack = try E2EStack.fromEnvironment()
        try await stack.clearEbayFaults()
        let item = try await stack.seedListedItem()
        launch(signedInTo: stack)

        let row = app.buttons["inventory.row.\(item.sku)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "the seeded item is not in the inventory")
        row.tap()
        let ebayStatus = app.descendants(matching: .any)["marketplace.ebay.status"]
        XCTAssertTrue(waitForLabel(of: ebayStatus, "Active (confirmed by eBay)", timeout: 30), ebayStatus.label)

        markSoldOnDepop()
        // The sale screen: the sale, its estimated fees and profit, and eBay's delist.
        let soldOn = app.staticTexts["sale.soldOn"]
        XCTAssertTrue(soldOn.waitForExistence(timeout: 15))
        XCTAssertTrue(soldOn.label.hasPrefix("Sold on Depop"), soldOn.label)
        let profit = app.descendants(matching: .any)["sale.profit"]
        XCTAssertTrue(profit.waitForExistence(timeout: 5))
        XCTAssertTrue(profit.label.contains("Profit (estimated)"), profit.label)
        let delist = app.descendants(matching: .any)["sale.delist.ebay"]
        XCTAssertTrue(waitForLabel(of: delist, "Delisted (confirmed by eBay)", timeout: 60), delist.label)
        keepScreenshot("Sale")

        // The item wears the sold stamp, and its string to eBay is cut (eBay confirmed the delist).
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let stamp = app.descendants(matching: .any)["item.soldStamp"]
        XCTAssertTrue(stamp.waitForExistence(timeout: 10), "the sold item has no sold stamp")
        XCTAssertTrue(stamp.label.hasPrefix("Sold for $") && stamp.label.hasSuffix(" on Depop"), stamp.label)
        // Mark as sold was below the fold: back to the tag and the string at the top.
        app.swipeDown()
        app.swipeDown()
        keepScreenshot("Sold, the string to eBay cut")
        let sale = app.buttons["item.sale"]
        for _ in 0 ..< 4 where !sale.isHittable {
            app.swipeUp()
        }
        sale.tap()
        XCTAssertTrue(soldOn.waitForExistence(timeout: 15))

        cancelAndRelistOnEbay()

        // The item's eBay listing is live again, as eBay confirms it.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(waitForLabel(of: ebayStatus, "Active (confirmed by eBay)", timeout: 60), ebayStatus.label)
        XCTAssertFalse(app.descendants(matching: .any)["item.relistPrompt"].exists)
        XCTAssertTrue(
            app.descendants(matching: .any)["item.soldStamp"].waitForNonExistence(timeout: 10),
            "a canceled sale leaves no sold stamp",
        )
        keepScreenshot("Relisted")

        // The Sales tab lists the sale.
        app.tabRail.buttons["Sales"].tap()
        let saleRow = app.buttons["sales.row.\(item.sku)"]
        XCTAssertTrue(saleRow.waitForExistence(timeout: 15), "the sale is not in the Sales tab")
        XCTAssertTrue(saleRow.label.contains("Canceled"), saleRow.label)
        keepScreenshot("Sales")
    }

    // MARK: Steps

    /// "Mark as sold" on Depop at the list price, with no shipping charged.
    private func markSoldOnDepop() {
        let markSold = app.buttons["item.markSold"]
        XCTAssertTrue(markSold.waitForExistence(timeout: 5))
        markSold.tap()
        let depop = app.buttons["markSold.marketplace.depop"]
        XCTAssertTrue(depop.waitForExistence(timeout: 5))
        depop.tap()
        keepScreenshot("Mark as sold")
        let save = app.buttons["markSold.save"]
        XCTAssertTrue(waitForEnabled(save), app.staticTexts["markSold.hint"].label)
        save.tap()
    }

    /// Cancel: Listora asks, relists nothing yet; choosing eBay relists it there.
    private func cancelAndRelistOnEbay() {
        app.buttons["sale.action.cancel"].tap()
        let confirm = app.buttons["sale.confirm.cancel"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        let option = app.buttons["relist.option.ebay"]
        XCTAssertTrue(option.waitForExistence(timeout: 15), "no relist question after the cancel")
        let status = app.descendants(matching: .any)["sale.status"]
        XCTAssertTrue(waitForLabel(of: status, "Canceled", timeout: 5), status.label)
        keepScreenshot("Relist it?")
        option.tap()
        let relist = app.buttons["relist.confirm"]
        XCTAssertTrue(waitForEnabled(relist))
        relist.tap()
        XCTAssertTrue(app.staticTexts["relist.done"].waitForExistence(timeout: 15))
    }

    private func launch(signedInTo stack: E2EStack) {
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": stack.token,
            "LISTORA_DEV_ACCESS_EMAIL": stack.email,
        ]
        app.launch()
        let inventory = app.tabRail.buttons["Inventory"]
        XCTAssertTrue(inventory.waitForExistence(timeout: 10))
        inventory.tap()
    }

    /// Keeps a screenshot in the result bundle, passing or not, for reviewing the screens.
    private func keepScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func waitForLabel(of element: XCUIElement, _ label: String, timeout: TimeInterval) -> Bool {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", label),
            object: element,
        )
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }

    private func waitForEnabled(_ element: XCUIElement, timeout: TimeInterval = 10) -> Bool {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"),
            object: element,
        )
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }
}
