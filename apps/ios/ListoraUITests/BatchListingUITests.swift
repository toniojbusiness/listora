import XCTest

/// Batch listing end to end against the local stack (`make ios-test`, packages/e2e): a 3-item haul
/// shot with the fake camera (front, back, and tag of each, from `BatchFixtures`), grouped into
/// three items, uploaded and analyzed by the server while the seller waits on the batch screen,
/// then reviewed with one cost split across the haul and one tap per item, and saved with SKUs.
@MainActor
final class BatchListingUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testAThreeItemHaulIsShotGroupedReviewedAndSavedWithSKUs() async throws {
        let stack = try E2EStack.fromEnvironment()
        try launch(signedInTo: stack)
        shootTheHaul()
        checkTheGrouping()
        waitForTheAnalyses()
        let skus = try reviewEveryItem()

        // The server has every item saved, at the recommended price, with its share of the cost.
        for sku in skus {
            let item = try await stack.item(sku: sku)
            XCTAssertEqual(item.status, "ready", sku)
            XCTAssertEqual(item.details.listPrice?.amountCents, 2600, sku)
            XCTAssertEqual(item.details.cost?.amountCents, 400, sku)
            XCTAssertNotNil(item.details.floorPrice, sku)
        }

        // Every item is in the inventory, ready to list.
        app.tabRail.buttons["Inventory"].tap()
        for sku in skus {
            XCTAssertTrue(app.buttons["inventory.row.\(sku)"].waitForExistence(timeout: 10), "\(sku) is not listed")
        }
    }

    // MARK: Steps

    private func launch(signedInTo stack: E2EStack) throws {
        let haul = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "BatchFixtures", withExtension: nil))
        app.launchEnvironment = [
            "LISTORA_FAKE_CAMERA": haul.path(percentEncoded: false),
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": stack.token,
            "LISTORA_DEV_ACCESS_EMAIL": stack.email,
        ]
        app.launch()
        let tab = app.tabRail.buttons["Add"]
        XCTAssertTrue(tab.waitForExistence(timeout: 10))
        tab.tap()
    }

    /// Batch mode, then nine photos in one go: the camera counts the items as it sees them.
    private func shootTheHaul() {
        app.segmentedControls["addItem.mode"].buttons["Batch"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["addItem.batchGuide"].waitForExistence(timeout: 5))
        app.buttons["addItem.shootBatch"].tap()
        let shutter = app.buttons["camera.shutter"]
        XCTAssertTrue(shutter.waitForExistence(timeout: 10))
        let item = app.staticTexts["batchCamera.item"]
        XCTAssertTrue(waitForLabel(of: item, prefix: "Item 1"), item.label)
        XCTAssertFalse(app.buttons["batchCamera.nextItem"].isEnabled, "Next item needs a photo first")
        for _ in 0 ..< 9 {
            XCTAssertTrue(waitUntilEnabled(shutter))
            shutter.tap()
        }
        // The last item is the third: Listora started items 2 and 3 on its own.
        XCTAssertTrue(waitForLabel(of: item, prefix: "Item 3", timeout: 15), item.label)
        keepScreenshot("Batch camera")
        let done = app.buttons["batchCamera.done"]
        XCTAssertTrue(waitForLabel(of: done, prefix: "Done (3 items)", timeout: 15), done.label)
        done.tap()
    }

    /// Three stacks of three photos; any close call is answered (they are different items).
    private func checkTheGrouping() {
        let summary = app.staticTexts["batchGrouping.summary"]
        XCTAssertTrue(summary.waitForExistence(timeout: 20), "the grouping never appeared")
        XCTAssertEqual(summary.label, "3 items from 9 photos")
        for index in 0 ..< 3 {
            XCTAssertTrue(app.buttons["batchGrouping.photo.\(index).2"].exists, "item \(index + 1) has no third photo")
        }
        keepScreenshot("Batch grouping")
        for index in 1 ..< 3 where app.buttons["batchGrouping.keepApart.\(index)"].exists {
            app.buttons["batchGrouping.keepApart.\(index)"].tap()
        }
        let confirm = app.buttons["batchGrouping.confirm"]
        XCTAssertEqual(confirm.label, "Create 3 items")
        confirm.tap()
    }

    /// The batch screen shows each item uploading, then the server's own words, until every item
    /// is analyzed and ready to review.
    private func waitForTheAnalyses() {
        XCTAssertTrue(app.staticTexts["batch.summary"].waitForExistence(timeout: 10))
        for index in 0 ..< 3 {
            let status = app.descendants(matching: .any)["batch.item.status.\(index)"]
            XCTAssertTrue(status.waitForExistence(timeout: 30), "item \(index + 1) has no status")
            XCTAssertTrue(
                waitForLabel(of: status, prefix: "Ready to review", timeout: 180),
                "item \(index + 1) never got analyzed: \(status.label)",
            )
        }
        keepScreenshot("Batch")
    }

    /// The first item's cost, split across the haul, then one tap per item. Returns the SKUs.
    private func reviewEveryItem() throws -> [String] {
        let review = app.buttons["batch.review"]
        XCTAssertTrue(waitForLabel(of: review, prefix: "Review 3 items"), review.label)
        review.tap()

        let firstApprove = app.buttons["batchReview.approve.1"]
        XCTAssertTrue(firstApprove.waitForExistence(timeout: 60), "the review never appeared")
        // Listora's uncertain details lead (the fake AI's brand and color).
        let attention = app.staticTexts["batchReview.attention.1"]
        XCTAssertTrue(attention.waitForExistence(timeout: 10))
        XCTAssertTrue(attention.label.hasPrefix("Check these"), attention.label)
        app.buttons["keypad.1"].tap()
        app.buttons["keypad.2"].tap()
        let cost = app.staticTexts["batchReview.cost.1"]
        XCTAssertEqual(cost.label, "$12")
        let split = app.buttons["batchReview.splitCost.1"]
        XCTAssertTrue(split.waitForExistence(timeout: 5))
        XCTAssertEqual(split.label, "Split $12.00 across 3 items, $4.00 each")
        split.tap()
        XCTAssertTrue(waitForLabel(of: cost, prefix: "$4"), cost.label)
        // Applied once: the card says so instead of offering to split the share again.
        XCTAssertTrue(app.descendants(matching: .any)["batchReview.costApplied.1"].waitForExistence(timeout: 5))
        XCTAssertFalse(split.exists)
        keepScreenshot("Batch review")

        for number in 1 ... 3 {
            let approve = app.buttons["batchReview.approve.\(number)"]
            XCTAssertTrue(
                waitForLabel(of: approve, prefix: "Approve at $26.00", timeout: 60),
                "item \(number): \(approve.label)",
            )
            XCTAssertTrue(waitUntilEnabled(approve))
            approve.tap()
        }

        let saved = app.staticTexts["batchSummary.saved"]
        XCTAssertTrue(saved.waitForExistence(timeout: 30), "the summary never appeared")
        XCTAssertEqual(saved.label, "3 of 3 saved")
        XCTAssertTrue(app.descendants(matching: .any)["batchSummary.metric"].label.contains(" taps"))
        var skus: [String] = []
        for index in 0 ..< 3 {
            let row = app.descendants(matching: .any)["batchSummary.item.\(index)"]
            let sku = row.label.firstMatch(of: /[A-Z0-9]{1,8}-[0-9]{6,}/).map { String($0.output) }
            try skus.append(XCTUnwrap(sku, row.label))
        }
        XCTAssertEqual(Set(skus).count, 3)
        keepScreenshot("Batch summary")
        app.buttons["batchSummary.done"].tap()
        return skus
    }

    // MARK: Helpers

    private func keepScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func waitForLabel(of element: XCUIElement, prefix: String, timeout: TimeInterval = 10) -> Bool {
        let predicate = NSPredicate(format: "label BEGINSWITH %@", prefix)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }

    private func waitUntilEnabled(_ element: XCUIElement, timeout: TimeInterval = 10) -> Bool {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"),
            object: element,
        )
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }
}
