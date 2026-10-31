import XCTest

/// The thrift scan end to end against the local stack (`make ios-test`, packages/e2e), with the
/// fake camera and the fake AI's scan of the fixture shirt (`FakeAI/default.json`): Add Item's
/// Scan mode, one shot read into a card with the call and the labeled AI estimate, Keep saving a
/// draft without leaving the camera, the next shot skipping the last one, the run's tray, and the
/// checkout at the register into a haul with the run's summary and estimated profit. The stack
/// shows every built feature, so Scan mode is on.
@MainActor
final class ThriftScanUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testAScanIsReadKeptAsADraftAndTheNextShotSkipsTheLast() throws {
        try launch(signedInTo: E2EStack.fromEnvironment())
        let scanMode = app.segmentedControls["addItem.mode"].buttons["Scan"]
        XCTAssertTrue(scanMode.waitForExistence(timeout: 15), "Scan mode shows where the thrift scan is on")
        scanMode.tap()
        XCTAssertTrue(app.staticTexts["Scan at the bins"].waitForExistence(timeout: 5))
        app.buttons["addItem.startScan"].tap()

        // Starting a run asks only where the seller is.
        let place = app.textFields["scanStart.place"]
        XCTAssertTrue(place.waitForExistence(timeout: 5))
        place.tap()
        place.typeText("Invented Thrift")
        attachScreenshot("start a run")
        app.buttons["scanStart.start"].tap()

        // One shot: the card lands with the call, its confidence, and the AI estimate under its label.
        let shutter = app.buttons["camera.shutter"]
        XCTAssertTrue(shutter.waitForExistence(timeout: 10))
        shutter.tap()
        let call = element("scan.call")
        XCTAssertTrue(call.waitForExistence(timeout: 20))
        XCTAssertEqual(call.label, "Your call")
        XCTAssertTrue(app.staticTexts["Low confidence"].exists)
        // The web research comes in after the card, under its label; one site keeps it low.
        XCTAssertTrue(element("scan.webInfo").waitForExistence(timeout: 20))
        XCTAssertTrue(element("scan.webInfo").label.contains("Web info - not sold listings"))
        attachScreenshot("scan card")
        XCTAssertEqual(app.staticTexts["scan.title"].label, "Acme Outfitters blue button-up shirt")
        XCTAssertEqual(app.staticTexts["scan.range"].label, "$15-$25")
        XCTAssertTrue(app.buttons["scan.search"].label.contains("Search Depop"))

        // Keep saves the draft without leaving the camera.
        app.buttons["scan.keep"].tap()
        XCTAssertTrue(element("scan.kept").waitForExistence(timeout: 10))
        XCTAssertEqual(element("scanCamera.summary").label, "1 scanned · 1 kept")
        XCTAssertTrue(shutter.exists)
        attachScreenshot("kept")

        // The next shot skips nothing kept and shows its own card; the tray holds both.
        shutter.tap()
        XCTAssertTrue(app.staticTexts["Item 2"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["scan.keep"].waitForExistence(timeout: 10))
        XCTAssertEqual(element("scanCamera.summary").label, "2 scanned · 1 kept")
        XCTAssertTrue(app.buttons["scan.tray.1"].label.hasSuffix("kept"), app.buttons["scan.tray.1"].label)
        attachScreenshot("second item")
        app.buttons["scan.tray.1"].tap()
        XCTAssertTrue(element("scan.kept").waitForExistence(timeout: 5))

        // Done keeps the run going; the kept draft uploads in the background.
        app.buttons["scanCamera.done"].tap()
        XCTAssertTrue(app.buttons["draft.row"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["This run"].exists)
        attachScreenshot("add item with the run")
        XCTAssertTrue(app.buttons["addItem.startScan"].label.contains("Keep scanning"))
        try checkOutTheRun()
    }

    /// Checkout at the register, from Add Item's bottom bar, into the run's summary.
    private func checkOutTheRun() throws {
        // Checkout at the register: what the haul cost, the kept item by default, the miles.
        app.buttons["addItem.checkoutScan"].tap()
        let paid = app.textFields["Paid for the haul"]
        XCTAssertTrue(paid.waitForExistence(timeout: 5))
        XCTAssertEqual(app.textFields["scanCheckout.items"].value as? String, "1")
        paid.tap()
        paid.typeText("3")
        app.textFields["scanCheckout.miles"].tap()
        app.textFields["scanCheckout.miles"].typeText("7")
        attachScreenshot("checkout")
        app.buttons["scanCheckout.submit"].tap()

        // The run's summary: the haul's cost, the estimated resale, and the estimated profit.
        XCTAssertTrue(element("runSummary.paid").waitForExistence(timeout: 20))
        XCTAssertEqual(element("runSummary.paid").label, "Paid $3.00 for 1 item · $3.00 each")
        XCTAssertEqual(element("runSummary.counts").label, "2 scanned · 1 kept · 7 miles")
        XCTAssertTrue(element("runSummary.resale").exists)
        XCTAssertTrue(element("runSummary.profit").exists)
        XCTAssertTrue(element("runSummary.label").label.contains("not based on sold listings"))
        attachScreenshot("run summary")
        app.buttons["scanCheckout.done"].tap()

        // The run is over; its summary stays on Add Item until the next run starts.
        XCTAssertTrue(app.buttons["addItem.startScan"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["addItem.startScan"].label.contains("Start scanning"))
        XCTAssertTrue(element("runSummary").waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["addItem.endScan"].exists)
        attachScreenshot("add item after checkout")
    }

    private func launch(signedInTo stack: E2EStack) throws {
        let fixtures = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "Fixtures", withExtension: nil))
        app.launchEnvironment = [
            "LISTORA_FAKE_CAMERA": fixtures.path(percentEncoded: false),
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": stack.token,
            "LISTORA_DEV_ACCESS_EMAIL": stack.email,
        ]
        app.launchQuietly()
        let tab = app.tabRail.buttons["Add"]
        XCTAssertTrue(tab.waitForExistence(timeout: 10))
        tab.tap()
    }

    /// Any element by its identifier: a stamp or label reads as text or as a group.
    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    private func attachScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
