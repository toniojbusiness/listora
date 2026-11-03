import XCTest

/// A scan card with everything on it fits the screen (docs/features/thrift-scan.md, "The card"):
/// against the stub's invented scan with every part filled, at a large text size, the card never
/// runs past the screen, it opens at its top (the verdict first, then the prices), what does not
/// fit scrolls inside the card, and Keep, Put back, and the camera stay reachable the whole time.
@MainActor
final class ThriftScanCardFitUITests: XCTestCase {
    private let app = XCUIApplication()
    private var server: StubAPIServer?

    override func setUp() async throws {
        continueAfterFailure = false
    }

    override func tearDown() async throws {
        server?.stop()
    }

    func testALongRealityCheckScrollsInsideTheCardWithKeepAndTheCameraReachable() throws {
        try scan(.fullRealityCheck)
        XCTAssertTrue(element("scan.reality").exists)
        try assertTheCardFits(bottom: "Often faked")
    }

    /// The card from a server without the reality check lists the call's signals instead.
    func testALongSignalListScrollsInsideTheCardWithKeepAndTheCameraReachable() throws {
        try scan(.signalList)
        XCTAssertTrue(element("scan.signal").exists)
        XCTAssertTrue(text(containing: StubAPIServer.lastSignalLabel).exists)
        try assertTheCardFits(bottom: "Often faked")
    }

    /// Opens Scan mode against the stub at a large text size and shoots one item.
    private func scan(_ answer: StubAPIServer.ScanAnswer) throws {
        let server = try StubAPIServer()
        server.scanAnswer = answer
        try server.start()
        self.server = server
        let fixtures = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "Fixtures", withExtension: nil))
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": server.baseURL,
            "LISTORA_DEV_ACCESS_TOKEN": "stub-token",
            "LISTORA_FAKE_CAMERA": fixtures.path(percentEncoded: false),
        ]
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityM"]
        app.launchQuietly()
        let tab = app.tabRail.buttons["Add"]
        XCTAssertTrue(tab.waitForExistence(timeout: 10))
        // A tap during the first launch's settling can leave Today on screen: tapped again.
        let scanMode = app.segmentedControls["addItem.mode"].buttons["Scan"]
        XCTAssertTrue(tab.tap(until: scanMode), "Scan mode shows where the thrift scan is on")
        scanMode.tap()
        app.buttons["addItem.startScan"].tap()
        let start = app.buttons["scanStart.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        start.tap()
        let shutter = app.buttons["camera.shutter"]
        XCTAssertTrue(shutter.waitForExistence(timeout: 10))
        shutter.tap()
        XCTAssertTrue(element("scan.call").waitForExistence(timeout: 20), "the card never showed its verdict")
    }

    /// The card is on the screen whole, the verdict and the prices first; the line at its bottom
    /// comes into view by scrolling inside the card; Keep, Put back, the shutter, and Done stay
    /// reachable throughout, and Keep still keeps.
    private func assertTheCardFits(bottom: String) throws {
        let window = app.windows.firstMatch.frame
        let card = element("scan.card")
        attachScreenshot("long card")
        XCTAssertGreaterThanOrEqual(card.frame.minY, window.minY, "the card runs off the top: \(card.frame)")
        XCTAssertLessThanOrEqual(card.frame.maxY, window.maxY, "the card runs off the bottom: \(card.frame)")
        assertReachable()
        // The card opens at its top: the verdict first, the prices next, the rest below them.
        XCTAssertTrue(element("scan.call").isHittable, "the verdict shows first")
        let prices = element("scan.prices").exists ? element("scan.prices") : element("scan.range")
        XCTAssertTrue(prices.exists, "no prices on the card")
        let last = text(containing: bottom)
        XCTAssertTrue(last.exists)
        XCTAssertLessThan(element("scan.call").frame.minY, prices.frame.minY)
        XCTAssertLessThan(prices.frame.minY, last.frame.minY)
        XCTAssertFalse(last.isHittable, "the fixture's card is long enough to scroll")

        // The bottom of the card's content scrolls into view inside the card.
        var swipes = 0
        while !last.isHittable, swipes < 8 {
            element("scan.content").swipeUp(velocity: .slow)
            swipes += 1
        }
        attachScreenshot("long card scrolled")
        XCTAssertTrue(last.isHittable, "the card's last line can't be reached")
        XCTAssertLessThanOrEqual(card.frame.maxY, window.maxY, "the card runs off the bottom: \(card.frame)")
        assertReachable()

        app.buttons["scan.keep"].tap()
        XCTAssertTrue(element("scan.confirmation").waitForExistence(timeout: 5), "a line says the item is kept")
        XCTAssertFalse(card.exists, "Keep closes the card")
    }

    private func assertReachable() {
        XCTAssertTrue(app.buttons["scan.keep"].isHittable, "Keep can't be reached")
        XCTAssertTrue(app.buttons["scan.putBack"].isHittable, "Put back can't be reached")
        XCTAssertTrue(app.buttons["camera.shutter"].isHittable, "the shutter can't be reached")
        XCTAssertTrue(app.buttons["scanCamera.done"].isHittable, "Done can't be reached")
    }

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    private func text(containing words: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
    }

    private func attachScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
