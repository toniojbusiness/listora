import XCTest

/// The inventory and item screens against the local stack, like `ListingFlowUITests`: two
/// seeded items, one listed on the fake eBay, and a delist eBay refuses.
extension ScreenshotTourUITests {
    func testInventoryTour() async throws {
        let stack = try E2EStack.fromEnvironment()
        try await stack.clearEbayFaults()
        let item = try await stack.seedReadyItem()
        let second = try await stack.seedReadyItem()
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": stack.token,
            "LISTORA_DEV_ACCESS_EMAIL": stack.email,
        ]
        app.launch()
        XCTAssertTrue(app.tabRail.waitForExistence(timeout: 10))
        tab("Inventory")
        let row = app.buttons["inventory.row.\(item.sku)"]
        // At the largest text sizes the grid is one column of tall tags, and the item can be below
        // the first screen, where the lazy grid has not made it yet.
        for _ in 0 ..< 4 where !row.waitForExistence(timeout: 5) {
            app.swipeUp()
        }
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        try shot("27-inventory")
        // The list, then back to the photo grid (the default).
        let layout = app.buttons["inventory.layout"]
        if layout.exists {
            layout.tap()
            try shot("45-inventory-list")
            layout.tap()
        }
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
        // The delist eBay refused puts the item in Needs you.
        app.buttons["inventory.filter.needsYou"].tap()
        try shot("65-inventory-needs-you", settle: 2)
        app.buttons["inventory.filter.all"].tap()
        try bulkTour(skus: [item.sku, second.sku])

        // Nothing has sold and no task is open on the stack.
        tab("Sales")
        try shot("38-sales-empty", settle: 3)
        tab("Tasks")
        try shot("39-tasks-empty", settle: 3)

        try markSoldTour(sku: second.sku)
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

    /// Select mode over both items, and the sheets of List all, Change price, and End all
    /// (each closed without sending anything).
    private func bulkTour(skus: [String]) throws {
        app.buttons["inventory.select"].tap()
        for sku in skus {
            app.buttons["inventory.row.\(sku)"].tap()
        }
        try shot("61-inventory-select")
        for (kind, name) in [("list", "62-bulk-list"), ("changePrice", "63-bulk-price"), ("end", "64-bulk-end")] {
            app.buttons["inventory.bulk.\(kind)"].tap()
            XCTAssertTrue(app.buttons["bulk.start"].waitForExistence(timeout: 10))
            try shot(name, settle: 1)
            app.buttons["bulk.close"].tap()
            XCTAssertTrue(app.buttons["inventory.select"].waitForExistence(timeout: 10))
            if kind != "end" {
                app.buttons["inventory.select"].tap()
                for sku in skus {
                    app.buttons["inventory.row.\(sku)"].tap()
                }
            }
        }
    }

    /// The other item sells: "Mark as sold", then its sale screen, celebrating.
    private func markSoldTour(sku: String) throws {
        tab("Inventory")
        let row = app.buttons["inventory.row.\(sku)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        let markSold = app.buttons["item.markSold"]
        for _ in 0 ..< 4 where !markSold.isHittable {
            app.swipeUp()
        }
        markSold.tap()
        let depop = app.buttons["markSold.marketplace.depop"]
        XCTAssertTrue(depop.waitForExistence(timeout: 5))
        depop.tap()
        try shot("46-mark-sold")
        let save = app.buttons["markSold.save"]
        XCTAssertTrue(save.wait(for: \.isEnabled, toEqual: true, timeout: 10))
        save.tap()
        XCTAssertTrue(app.staticTexts["sale.soldOn"].waitForExistence(timeout: 15))
        try shot("47-sold-celebration", settle: 0.5)
        // Back on the item: the sold stamp pressed onto its tag.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.descendants(matching: .any)["item.soldStamp"].waitForExistence(timeout: 10))
        // Mark as sold was below the fold: back to the tag at the top.
        app.swipeDown()
        app.swipeDown()
        try shot("48-item-sold")
    }

    private func waitForLabel(of element: XCUIElement, _ label: String, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "label == %@", label)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }
}
