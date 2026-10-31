import XCTest

/// The thrift scan end to end against the local stack (`make ios-test`, packages/e2e), with the
/// fake camera and the fake AI's scan of the fixture shirt (`FakeAI/default.json`): Add Item's
/// Scan mode, one shot read into a card with the call and the labeled AI estimate, Keep and Put
/// back each closing the card straight back to the camera for the next shot, the run's tray, and the
/// checkout at the register into a haul with the run's summary and estimated profit. The stack
/// shows every built feature, so Scan mode is on.
@MainActor
final class ThriftScanUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testAScanIsKeptOrPutBackStraightBackToTheCamera() throws {
        try launch(signedInTo: E2EStack.fromEnvironment())
        let scanMode = app.segmentedControls["addItem.mode"].buttons["Scan"]
        XCTAssertTrue(scanMode.waitForExistence(timeout: 15), "Scan mode shows where the thrift scan is on")
        scanMode.tap()
        XCTAssertTrue(app.staticTexts["Scan at the bins"].waitForExistence(timeout: 5))
        // Starting a run asks only where the seller is.
        startRun(at: "Invented Thrift")

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

        try keepThenPutBack(shutter)

        // Done keeps the run going; the kept draft uploads in the background.
        app.buttons["scanCamera.done"].tap()
        XCTAssertTrue(app.buttons["draft.row"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["This run"].exists)
        attachScreenshot("add item with the run")
        XCTAssertTrue(app.buttons["addItem.startScan"].label.contains("Keep scanning"))
        try checkOutTheRun()
    }

    /// Keep closes the card at once, back to the live camera, with a brief line; the next item's
    /// Put back does the same; the tray opens the kept one with Close.
    private func keepThenPutBack(_ shutter: XCUIElement) throws {
        // Keep closes the card at once, back to the live camera for the next shot, and a brief
        // line says it was kept. The draft is saved in the background: Keep waits for the
        // upload-sized photo, prepared at utility priority (over 10 s on a loaded test machine).
        let card = element("scan.card")
        let keepTapped = Date()
        app.buttons["scan.keep"].tap()
        // The line stands where the card was for 2 s once the draft is saved: looked for first.
        let confirmation = element("scan.confirmation")
        XCTAssertTrue(confirmation.waitForExistence(timeout: 2), "a line says the item is kept")
        let cameraReady = Date().timeIntervalSince(keepTapped)
        XCTAssertFalse(card.exists, "Keep closes the card")
        XCTAssertTrue(shutter.isHittable)
        let said = confirmation.label
        XCTAssertTrue(said.contains("Kept · 1 in this run") || said.contains("Keeping item 1"), said)
        attachScreenshot("kept")
        record("Keep to the camera clear, by the test (tap and polling included): \(Int(cameraReady * 1000)) ms")
        XCTAssertTrue(waitForLabel(of: element("scanCamera.summary"), prefix: "1 scanned · 1 kept", timeout: 20))

        // The next shot shows its own card; Put back passes on it, back to the camera.
        shutter.tap()
        XCTAssertTrue(app.staticTexts["Item 2"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["scan.keep"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["scan.putBack"].exists)
        XCTAssertEqual(element("scanCamera.summary").label, "2 scanned · 1 kept")
        attachScreenshot("second item")
        app.buttons["scan.putBack"].tap()
        XCTAssertTrue(confirmation.waitForExistence(timeout: 2), "a line says the item was put back")
        XCTAssertTrue(confirmation.label.contains("Put back · 1 kept this run"), confirmation.label)
        XCTAssertFalse(card.exists, "Put back closes the card")
        attachScreenshot("put back")

        // The tray holds both; the kept one opens with Close, back to the camera.
        XCTAssertTrue(app.buttons["scan.tray.1"].label.hasSuffix("kept"), app.buttons["scan.tray.1"].label)
        app.buttons["scan.tray.1"].tap()
        XCTAssertTrue(element("scan.kept").waitForExistence(timeout: 5))
        app.buttons["scan.close"].tap()
        XCTAssertTrue(card.waitForNonExistence(timeout: 5))
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
        // Every resale number says it is an estimate (the fixture's call rests on web info).
        XCTAssertTrue(element("runSummary.label").label.hasPrefix("Estimated"), element("runSummary.label").label)
        attachScreenshot("run summary")
        app.buttons["scanCheckout.done"].tap()

        // The run is over; its summary stays on Add Item until the next run starts.
        XCTAssertTrue(app.buttons["addItem.startScan"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["addItem.startScan"].label.contains("Start scanning"))
        XCTAssertTrue(element("runSummary").waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["addItem.endScan"].exists)
        attachScreenshot("add item after checkout")
    }

    /// M6: the kept draft "Needs photos"; Shoot this run takes its real photos with the scan's name
    /// on screen, the scan shot goes, and the run's rapid review analyzes and approves it.
    func testAKeptScanIsShotWithRealPhotosThenReviewed() throws {
        try launch(signedInTo: E2EStack.fromEnvironment())
        let scanMode = app.segmentedControls["addItem.mode"].buttons["Scan"]
        XCTAssertTrue(scanMode.waitForExistence(timeout: 15))
        scanMode.tap()
        startRun()
        let shutter = app.buttons["camera.shutter"]
        XCTAssertTrue(shutter.waitForExistence(timeout: 10))
        shutter.tap()
        XCTAssertTrue(app.buttons["scan.keep"].waitForExistence(timeout: 20))
        app.buttons["scan.keep"].tap()
        XCTAssertTrue(waitForLabel(of: element("scanCamera.summary"), prefix: "1 scanned · 1 kept", timeout: 20))
        app.buttons["scanCamera.done"].tap()

        // The kept draft is listed under its run, named by the scan, and needs its photos.
        XCTAssertTrue(element("keptRun.header").waitForExistence(timeout: 10))
        XCTAssertTrue(element("draft.needsPhotos").waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["draft.row"].label.contains("Acme Outfitters blue button-up shirt"))
        XCTAssertFalse(app.buttons["keptRun.review"].exists, "a draft with only its scan shot is never reviewed")
        attachScreenshot("needs photos")

        // Shoot this run: the guided camera with the item's name, front, back, and tag.
        app.buttons["keptRun.shoot"].tap()
        let title = app.staticTexts["runShoot.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        XCTAssertEqual(title.label, "1 of 1: Acme Outfitters blue button-up shirt")
        attachScreenshot("shoot this run")
        for step in 1 ... 3 {
            XCTAssertTrue(waitUntilEnabled(shutter), "shot \(step)")
            shutter.tap()
        }
        let done = app.buttons["camera.done"]
        XCTAssertTrue(waitForLabel(of: done, prefix: "Done (3)"), done.label)
        done.tap()

        // The real photos replace the scan shot; once they are on the server the run is reviewed.
        XCTAssertTrue(app.buttons["draft.row"].waitForExistence(timeout: 10))
        XCTAssertTrue(waitForLabel(of: app.buttons["draft.row"], prefix: "Acme"), app.buttons["draft.row"].label)
        XCTAssertTrue(app.buttons["draft.row"].label.contains("3 photos"), app.buttons["draft.row"].label)
        XCTAssertFalse(element("draft.needsPhotos").exists)
        let review = app.buttons["keptRun.review"]
        XCTAssertTrue(waitForLabel(of: review, prefix: "Review 1 item", timeout: 60), review.label)
        attachScreenshot("ready to review")
        review.tap()

        let approve = app.buttons["batchReview.approve.1"]
        XCTAssertTrue(approve.waitForExistence(timeout: 60), "the review never appeared")
        XCTAssertTrue(waitForLabel(of: approve, prefix: "Approve at", timeout: 60), approve.label)
        XCTAssertTrue(waitUntilEnabled(approve))
        attachScreenshot("run review")
        approve.tap()
        let saved = app.staticTexts["batchSummary.saved"]
        XCTAssertTrue(saved.waitForExistence(timeout: 30), "the summary never appeared")
        XCTAssertEqual(saved.label, "1 of 1 saved")
        XCTAssertTrue(app.navigationBars["Run reviewed"].exists)
        app.buttons["batchSummary.done"].tap()
        // Approved, its draft is done on this iPhone.
        XCTAssertTrue(app.buttons["draft.row"].waitForNonExistence(timeout: 10))
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

    /// Starts a run from Add Item: the start sheet asks where the seller is, which can be left out.
    private func startRun(at place: String? = nil) {
        app.buttons["addItem.startScan"].tap()
        let start = app.buttons["scanStart.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        if let place {
            let field = app.textFields["scanStart.place"]
            field.tap()
            field.typeText(place)
            attachScreenshot("start a run")
        }
        start.tap()
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

    /// A measurement, kept in the result bundle and printed to the test log.
    private func record(_ line: String) {
        print(line)
        let attachment = XCTAttachment(string: line)
        attachment.name = "measurement"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func attachScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
