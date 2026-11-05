import XCTest

extension ThriftScanUITests {
    /// Shoot the tag: the card steps aside so the camera is clear for the close-up, Cancel brings
    /// it back unchanged, and the tag shot brings the same card back read with the tag; Keep then
    /// works as before.
    func testShootingTheTagClearsTheCardThenBringsItBackRead() throws {
        try launch(signedInTo: E2EStack.fromEnvironment())
        let scanMode = app.segmentedControls["addItem.mode"].buttons["Scan"]
        XCTAssertTrue(scanMode.waitForExistence(timeout: 15))
        scanMode.tap()
        startRun()
        let shutter = app.buttons["camera.shutter"]
        XCTAssertTrue(shutter.waitForExistence(timeout: 10))
        shutter.tap()
        let card = element("scan.card")
        XCTAssertTrue(waitForTheRead(of: 1))
        XCTAssertTrue(element("scan.call").waitForExistence(timeout: 20))
        let title = app.staticTexts["scan.title"].label
        XCTAssertTrue(app.buttons["scan.tag"].label.hasPrefix("Shoot the tag"), app.buttons["scan.tag"].label)

        // Shoot the tag: the card goes, the camera is clear, and the shutter takes the tag.
        app.buttons["scan.tag"].tap()
        XCTAssertTrue(card.waitForNonExistence(timeout: 3), "the card steps aside for the tag shot")
        XCTAssertTrue(element("scanCamera.tagPrompt").exists)
        XCTAssertEqual(shutter.label, "Shoot the tag")
        XCTAssertTrue(shutter.isHittable)
        attachScreenshot("framing the tag")

        // Cancel brings the same card back, unchanged.
        app.buttons["scanCamera.cancelTag"].tap()
        XCTAssertTrue(card.waitForExistence(timeout: 3), "Cancel brings the card back")
        XCTAssertEqual(app.staticTexts["scan.title"].label, title)
        XCTAssertTrue(app.buttons["scan.tag"].label.hasPrefix("Shoot the tag"), app.buttons["scan.tag"].label)
        XCTAssertEqual(shutter.label, "Scan an item")

        // The tag shot: the same card comes back, read again with the tag; still one item.
        app.buttons["scan.tag"].tap()
        XCTAssertTrue(card.waitForNonExistence(timeout: 3))
        shutter.tap()
        XCTAssertTrue(card.waitForExistence(timeout: 5), "the card comes back after the tag shot")
        // The card's tools, "Retake the tag" among them, come back only once the read with the tag
        // landed: it waits as long as a read may take.
        let retake = app.buttons["scan.tag"]
        XCTAssertTrue(waitForLabel(of: retake, prefix: "Retake the tag", timeout: Self.readDeadline), retake.label)
        // The read with the tag waits for its own prices again, then shows its verdict.
        XCTAssertTrue(element("scan.call").waitForExistence(timeout: 20))
        XCTAssertEqual(app.staticTexts["scan.title"].label, title)
        XCTAssertFalse(element("scanCamera.tagPrompt").exists)
        XCTAssertTrue(element("scanCamera.summary").label.hasPrefix("1 scanned"), element("scanCamera.summary").label)
        attachScreenshot("card back with the tag")

        // Keep works as before.
        app.buttons["scan.keep"].tap()
        expect(confirmationLine(), saying: ["Kept · 1 in this run", "Keeping item 1"])
        XCTAssertFalse(card.exists)
        XCTAssertTrue(waitForTheKeep(of: 1, summary: "1 scanned · 1 kept"))
    }
}
