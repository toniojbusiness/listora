import XCTest

/// The inventory and item screens against the local stack, like `ListingFlowUITests`: two
/// seeded items, one listed on the fake eBay, and a delist eBay refuses.
extension ScreenshotTourUITests {
    func testInventoryTour() async throws {
        let stack = try E2EStack.fromEnvironment()
        try await stack.clearEbayFaults()
        let item = try await stack.seedReadyItem()
        _ = try await stack.seedReadyItem()
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": stack.token,
            "LISTORA_DEV_ACCESS_EMAIL": stack.email,
        ]
        app.launch()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 10))
        tab("Inventory")
        let row = app.buttons["inventory.row.\(item.sku)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        try shot("27-inventory")
        row.tap()

        let status = app.descendants(matching: .any)["marketplace.ebay.status"]
        XCTAssertTrue(waitForLabel(of: status, "Not listed", timeout: 15), status.label)
        try shot("28-item")
        app.swipeUp()
        try shot("29-item-details")
        app.swipeDown()
        app.swipeDown()
        try listingTour(status: status)
        try await delistFailureTour(stack: stack, status: status)

        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        try shot("34-inventory-statuses", settle: 3)

        // Nothing has sold and no task is open on the stack.
        tab("Sales")
        try shot("38-sales-empty", settle: 3)
        tab("Tasks")
        try shot("39-tasks-empty", settle: 3)
        app.terminate()
    }

    /// Choose eBay, the eBay version, and the published listing once eBay confirmed it.
    private func listingTour(status: XCUIElement) throws {
        app.buttons["marketplace.ebay.action.list"].tap()
        let next = app.buttons["listing.next"]
        XCTAssertTrue(next.waitForExistence(timeout: 10))
        try shot("30-listing-marketplaces")
        next.tap()
        XCTAssertTrue(app.textFields["listing.title"].waitForExistence(timeout: 5))
        try shot("31-listing-ebay")
        app.buttons["listing.publish"].tap()
        XCTAssertTrue(waitForLabel(of: status, "Active (confirmed by eBay)", timeout: 60), status.label)
        try shot("32-item-active")
    }

    /// eBay refuses the delist: the failure with Retry.
    private func delistFailureTour(stack: E2EStack, status: XCUIElement) async throws {
        try await stack.injectEbayFault(action: "end", type: "reject", message: "The listing cannot be ended now.")
        app.buttons["marketplace.ebay.action.end"].tap()
        let endButton = app.buttons["End: no longer available"].firstMatch
        XCTAssertTrue(endButton.waitForExistence(timeout: 5))
        endButton.tap()
        XCTAssertTrue(waitForLabel(of: status, "Delist failed - Retry", timeout: 60), status.label)
        try shot("33-item-delist-failed")
        try await stack.clearEbayFaults()
    }

    private func waitForLabel(of element: XCUIElement, _ label: String, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "label == %@", label)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }
}
