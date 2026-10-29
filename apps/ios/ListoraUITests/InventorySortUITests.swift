import XCTest

/// Inventory's Sort control against the local stack: the server sorts the items by price, and the
/// seller's choice is still in effect after the app is relaunched.
@MainActor
final class InventorySortUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testSortsByPriceAndRemembersTheChoice() async throws {
        let stack = try E2EStack.fromEnvironment()
        // Dearer than any other test's item, so they are the first three by price; added cheapest
        // last, so newest first is the other way around.
        let priced = { (cents: Int) in ["listPrice": ["amountCents": cents, "currency": "USD"]] }
        let middle = try await stack.seedReadyItem(details: priced(900_200))
        let dearest = try await stack.seedReadyItem(details: priced(900_300))
        let cheapest = try await stack.seedReadyItem(details: priced(900_100))
        launch(signedInTo: stack, resetting: true)
        let sort = app.buttons["inventory.sort"]
        try require(sort.waitForExistence(timeout: 15), "no Sort control")
        XCTAssertEqual(sort.value as? String, "Recently added")
        try require(row(cheapest.sku).waitForExistence(timeout: 15), "the seeded items are not in the inventory")

        sort.tap()
        let byPrice = app.buttons["Price: high to low"]
        try require(byPrice.waitForExistence(timeout: 5), "no price order in the Sort menu")
        byPrice.tap()
        try require(waitForValue(of: sort, "Price: high to low"))
        try require(waitForOrder([dearest.sku, middle.sku, cheapest.sku]), "not sorted by price")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "Sorted by price"
        shot.lifetime = .keepAlways
        add(shot)

        // Relaunched, the list opens in the same order.
        app.terminate()
        launch(signedInTo: stack, resetting: false)
        try require(sort.waitForExistence(timeout: 15))
        XCTAssertEqual(sort.value as? String, "Price: high to low")
        try require(waitForOrder([dearest.sku, middle.sku, cheapest.sku]), "the order was not remembered")

        // Back to the default, for the tests that run after this one without a reset.
        sort.tap()
        app.buttons["Recently added"].tap()
        try require(waitForValue(of: sort, "Recently added"))
    }

    private func launch(signedInTo stack: E2EStack, resetting: Bool) {
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": resetting ? "1" : "0",
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": stack.token,
            "LISTORA_DEV_ACCESS_EMAIL": stack.email,
        ]
        app.launch()
        let inventory = app.tabRail.buttons["Inventory"]
        XCTAssertTrue(inventory.waitForExistence(timeout: 10))
        inventory.tap()
    }

    private func row(_ sku: String) -> XCUIElement {
        app.buttons["inventory.row.\(sku)"]
    }

    /// Whether the rows come in this order on screen (the grid reads left to right, then down).
    private func waitForOrder(_ skus: [String], timeout: TimeInterval = 15) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            let frames = skus.map { row($0) }.filter(\.exists).map(\.frame)
            let inOrder = zip(frames, frames.dropFirst()).allSatisfy { before, after in
                before.minY < after.minY - 1 || (abs(before.minY - after.minY) <= 1 && before.minX < after.minX)
            }
            if frames.count == skus.count, inOrder {
                return true
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        } while Date() < deadline
        return false
    }

    private func waitForValue(of element: XCUIElement, _ value: String, timeout: TimeInterval = 10) -> Bool {
        let predicate = NSPredicate(format: "value == %@", value)
        let expectation = expectation(for: predicate, evaluatedWith: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }
}
