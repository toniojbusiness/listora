import XCTest

/// Inventory's select mode against the local stack with the fake eBay: List all, Change price,
/// and End all over two items, a refused delist that lands the item in Needs you, and Delete,
/// which keeps an item that is still live. Every status waited for is the server's own label.
@MainActor
final class BulkActionsUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testListAllChangePriceEndAllAndDeleteFromInventory() async throws {
        let stack = try E2EStack.fromEnvironment()
        try await stack.clearEbayFaults()
        let first = try await stack.seedReadyItem()
        let second = try await stack.seedReadyItem()
        let spare = try await stack.seedReadyItem()
        launch(signedInTo: stack)
        let firstRow = app.buttons["inventory.row.\(first.sku)"]
        let secondRow = app.buttons["inventory.row.\(second.sku)"]
        try require(secondRow.waitForExistence(timeout: 15), "the seeded items are not in the inventory")

        // List all: eBay, the marketplace Listora lists on itself here, is chosen.
        try choose([first.sku, second.sku])
        app.buttons["inventory.bulk.list"].tap()
        try require(app.switches["bulk.marketplace.ebay"].waitForExistence(timeout: 10))
        keepScreenshot("List all")
        try start()
        try require(waitForLabel(
            of: outcome(first.sku, "ebay"),
            "Listing on eBay started",
            timeout: 30,
            contains: true,
        ))
        keepScreenshot("List all results")
        app.buttons["bulk.done"].tap()
        try waitForEbay(of: first.sku, "Active (confirmed by eBay)")
        try waitForEbay(of: second.sku, "Active (confirmed by eBay)")

        // Change price: 10% lower, $45.00 to $40.50 on eBay and on the item.
        try choose([first.sku, second.sku])
        app.buttons["inventory.bulk.changePrice"].tap()
        let example = app.descendants(matching: .any)["bulk.price.example"]
        try require(waitForLabel(of: example, "$45.00 becomes $40.50", timeout: 10, contains: true), example.label)
        try start()
        try require(waitForLabel(
            of: outcome(first.sku, "ebay"),
            "Changing to $40.50 on eBay",
            timeout: 30,
            contains: true,
        ))
        app.buttons["bulk.done"].tap()
        try waitForEbay(of: first.sku, "Active (confirmed by eBay)", price: "$40.50")
        try waitForEbay(of: second.sku, "Active (confirmed by eBay)", price: "$40.50")

        let failed = try await endAllWithOneRefused(stack: stack, skus: [first.sku, second.sku])
        try deleteKeepsWhatIsLive(live: failed, spare: spare.sku)
        try require(firstRow.exists)
    }

    // MARK: Steps

    /// End all, with eBay refusing one delist: that item needs the seller. Returns its SKU.
    private func endAllWithOneRefused(stack: E2EStack, skus: [String]) async throws -> String {
        // End all, with eBay refusing one delist: that item needs the seller.
        try await stack.injectEbayFault(action: "end", type: "reject", message: "The listing cannot be ended now.")
        try choose(skus)
        app.buttons["inventory.bulk.end"].tap()
        app.buttons["bulk.end.notAvailable"].tap()
        try start()
        try require(app.buttons["bulk.done"].waitForExistence(timeout: 30))
        app.buttons["bulk.done"].tap()
        // The list reads the server when its filter changes; the refusal lands within seconds.
        var refused: String?
        for _ in 0 ..< 20 where refused == nil {
            app.buttons["inventory.filter.needsYou"].tap()
            refused = skus.first { sku in
                let row = app.buttons["inventory.row.\(sku)"]
                return row.waitForExistence(timeout: 3) && row.label.contains("Needs you")
            }
            if refused == nil {
                app.buttons["inventory.filter.all"].tap()
            }
        }
        let sku = try XCTUnwrap(refused, "the refused delist is not in Needs you")
        keepScreenshot("Needs you")
        try await stack.clearEbayFaults()
        app.buttons["inventory.filter.all"].tap()
        return sku
    }

    /// Delete keeps an item that is still on a marketplace, with the server's reason.
    private func deleteKeepsWhatIsLive(live: String, spare: String) throws {
        try choose([live, spare])
        app.buttons["inventory.bulk.delete"].tap()
        try start()
        app.buttons["bulk.delete.confirm"].firstMatch.tap()
        try require(waitForLabel(of: outcome(spare, "item"), "Deleted.", timeout: 30, contains: true))
        try require(waitForLabel(of: outcome(live, "item"), "End its listings", timeout: 5, contains: true))
        keepScreenshot("Delete results")
        app.buttons["bulk.done"].tap()
        try require(waitForAbsence(of: app.buttons["inventory.row.\(spare)"]), "the deleted item is still listed")
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

    /// Select mode with exactly these items chosen.
    private func choose(_ skus: [String]) throws {
        let select = app.buttons["inventory.select"]
        try require(select.waitForExistence(timeout: 10))
        select.tap()
        for sku in skus {
            let row = app.buttons["inventory.row.\(sku)"]
            try require(row.waitForExistence(timeout: 10), "no row for \(sku)")
            tapRow(row)
        }
        try require(app.staticTexts["\(skus.count) selected"].waitForExistence(timeout: 5), "not \(skus.count) chosen")
    }

    /// Taps a row in select mode at its photo, a quarter of the way down the card, once that
    /// point is clear of the bars: the grid's cards are tall, and a tap at the middle of one low on
    /// the screen landed on the selection bar's padding and chose nothing.
    private func tapRow(_ row: XCUIElement) {
        let bar = app.buttons["inventory.bulk.list"]
        let scroll = app.scrollViews.firstMatch
        var point: CGFloat {
            row.frame.minY + row.frame.height / 4
        }
        for _ in 0 ..< 6 {
            let bottom = (bar.exists ? bar.frame.minY : app.windows.firstMatch.frame.maxY) - 80
            let top = app.navigationBars.firstMatch.frame.maxY + 20
            if point > bottom {
                scroll.swipeUp(velocity: .slow)
            } else if point < top {
                scroll.swipeDown(velocity: .slow)
            } else {
                break
            }
        }
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
    }

    private func start() throws {
        let start = app.buttons["bulk.start"]
        try require(start.waitForExistence(timeout: 10))
        try require(waitForEnabled(start))
        start.tap()
    }

    private func outcome(_ sku: String, _ marketplace: String) -> XCUIElement {
        app.descendants(matching: .any)["bulk.outcome.\(sku).\(marketplace)"]
    }

    /// Opens the item and waits for its eBay card to say `label` (and show `price`), then goes back.
    private func waitForEbay(of sku: String, _ label: String, price: String? = nil) throws {
        let row = app.buttons["inventory.row.\(sku)"]
        try require(row.waitForExistence(timeout: 10))
        row.tap()
        let status = app.descendants(matching: .any)["marketplace.ebay.status"]
        try require(waitForLabel(of: status, label, timeout: 60), "\(sku): \(status.label)")
        if let price {
            let shown = app.descendants(matching: .any)["marketplace.ebay.price"]
            try require(waitForLabel(of: shown, price, timeout: 10, contains: true), "\(sku): \(shown.label)")
        }
        app.navigationBars.buttons.element(boundBy: 0).tap()
        try require(row.waitForExistence(timeout: 10))
    }

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
