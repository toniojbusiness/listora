import XCTest

/// Visits every screen and saves a screenshot of each, for design reviews (`make ios-screenshots`,
/// which runs it once per appearance and text size). It runs only when the test runner has
/// `LISTORA_SCREENSHOT_DIR` (from `TEST_RUNNER_LISTORA_SCREENSHOT_DIR`), so `make ios-test` skips it.
///
/// The screenshots land in `<dir>/<LISTORA_SCREENSHOT_VARIANT>/NN-screen.png`. The API is
/// `StubAPIServer`; the first pass starts signed out, as on a fresh install.
@MainActor
final class ScreenshotTourUITests: XCTestCase {
    let app = XCUIApplication()
    private var server: StubAPIServer?
    private var directory: URL?

    override func setUp() async throws {
        continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        guard let path = environment["LISTORA_SCREENSHOT_DIR"], !path.isEmpty else {
            throw XCTSkip("Set TEST_RUNNER_LISTORA_SCREENSHOT_DIR to take screenshots (make ios-screenshots).")
        }
        let variant = environment["LISTORA_SCREENSHOT_VARIANT"] ?? "default"
        let directory = URL(filePath: path, directoryHint: .isDirectory).appending(path: variant)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        self.directory = directory
        let server = try StubAPIServer()
        try server.start()
        self.server = server
    }

    override func tearDown() async throws {
        server?.stop()
    }

    private var fixturesPath: String {
        get throws {
            let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "Fixtures", withExtension: nil))
            return url.path(percentEncoded: false)
        }
    }

    func testTour() throws {
        try signInTour(server: XCTUnwrap(server))
        try offlineTour()
        try signedInTour(server: XCTUnwrap(server))
    }

    /// The review flow against the local stack (`make ios-screenshots` starts it, with the fake AI
    /// of `ReviewFlowUITests`): the analysis, the confidence-first review, cost, price, and the
    /// saved item.
    func testReviewTour() throws {
        let stack = try E2EStack.fromEnvironment()
        app.launchEnvironment = try [
            "LISTORA_FIXTURE_PHOTOS": fixturesPath,
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": stack.token,
            "LISTORA_DEV_ACCESS_EMAIL": stack.email,
        ]
        app.launch()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 10))
        tab("Add")
        app.buttons["addItem.importPhotos"].tap()
        let tagPhoto = app.buttons["photo.tile.2"]
        XCTAssertTrue(tagPhoto.waitForExistence(timeout: 15))
        tagPhoto.tap()
        let tag = app.buttons["photo.role.tag"]
        if !tag.isHittable || tag.frame.maxY > app.buttons["photo.crop"].frame.minY {
            app.scrollViews.firstMatch.swipeUp()
        }
        tag.tap()
        app.buttons["photo.done"].tap()

        try reviewTour()
        try costTour()
        try priceTour()
        app.buttons["price.save"].tap()
        XCTAssertTrue(app.staticTexts["saved.sku"].waitForExistence(timeout: 15))
        try shot("26-saved")
        app.terminate()
    }

    /// The analysis (when it is slow enough to catch) and the review, top to bottom.
    private func reviewTour() throws {
        app.buttons["draft.review"].tap()
        if app.descendants(matching: .any)["review.progress"].waitForExistence(timeout: 5) {
            try shot("15-review-analyzing", settle: 0.3)
        }
        // The review's bar; at the largest text sizes the attention section starts off screen.
        XCTAssertTrue(app.buttons["review.continue"].waitForExistence(timeout: 120))
        try shot("16-review")
        app.swipeUp()
        try shot("17-review-details")
        app.swipeUp()
        app.swipeUp()
        try shot("18-review-copy")
        enterSize()
        app.buttons["review.continue"].tap()
    }

    /// The tag doesn't show the shirt's size, and Continue waits for it. The size leads the
    /// review's list, so it is back at the top.
    private func enterSize() {
        let size = app.buttons["review.field.sizeLabel"]
        let barTop = app.buttons["voice.talk"].frame.minY
        for _ in 0 ..< 8 where !(size.exists && size.isHittable && size.frame.maxY < barTop) {
            app.swipeDown()
        }
        size.tap()
        let editor = app.textFields["review.editor.sizeLabel"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        // Return commits it: at the largest text sizes the keyboard scrolls the row's Done button
        // under the navigation bar.
        editor.typeText("M\n")
        XCTAssertTrue(app.buttons["review.continue"].wait(for: \.isEnabled, toEqual: true, timeout: 5))
    }

    private func costTour() throws {
        XCTAssertTrue(app.staticTexts["cost.amount"].waitForExistence(timeout: 10))
        try shot("19-cost-empty", settle: 1)
        app.buttons["keypad.1"].tap()
        app.buttons["keypad.2"].tap()
        try shot("20-cost")
        app.buttons["cost.continue"].tap()
    }

    /// The price options, a floor opened, the sources, and a price of the seller's under every
    /// floor. Ends with the recommended price chosen.
    private func priceTour() throws {
        let recommended = app.buttons["price.tier.recommended"]
        XCTAssertTrue(recommended.waitForExistence(timeout: 15))
        try shot("21-price")
        app.swipeUp()
        app.buttons["price.floor.ebay"].tap()
        try shot("22-price-floors")
        app.swipeUp()
        app.swipeUp()
        try shot("23-price-sources")
        app.buttons["price.setOwn"].tap()
        XCTAssertTrue(app.buttons["price.customUse"].waitForExistence(timeout: 5))
        // From the chosen $26 to $9, under every floor.
        for _ in 0 ..< 4 {
            app.buttons["keypad.delete"].tap()
        }
        app.buttons["keypad.9"].tap()
        try shot("24-price-custom")
        app.buttons["price.customUse"].tap()
        try shot("25-price-below-floor")
        app.swipeDown()
        app.swipeDown()
        recommended.tap()
        XCTAssertTrue(recommended.isSelected)
    }

    /// Signed in with no server answering: drafts stay on the phone, and the screens that load
    /// from the server say they could not.
    private func offlineTour() throws {
        app.launchEnvironment = try [
            "LISTORA_FIXTURE_PHOTOS": fixturesPath,
            "LISTORA_FAKE_CAMERA": fixturesPath,
            "LISTORA_RESET_LOCAL_DATA": "1",
        ]
        app.signInWithoutServer()
        app.launch()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 10))
        try shot("00-today-offline")

        tab("Inventory")
        try shot("01-inventory")

        tab("Add")
        XCTAssertTrue(app.buttons["addItem.importPhotos"].waitForExistence(timeout: 5))
        try shot("02-add-item")

        try captureTour()
        try draftTour()

        tab("Tasks")
        try shot("09-tasks")

        tab("Sales")
        try shot("35-sales-offline")

        tab("Today")
        app.buttons["settings.open"].tap()
        XCTAssertTrue(app.buttons["settings.marketplaces"].waitForExistence(timeout: 5))
        try shot("10-settings")

        // Nothing answers at the API, so the list cannot load.
        app.buttons["settings.marketplaces"].tap()
        XCTAssertTrue(app.navigationBars["Marketplaces"].waitForExistence(timeout: 5))
        try shot("11-marketplaces-unavailable", settle: 3)
        app.terminate()
    }

    /// Signed in against the stub: the marketplaces load, and uploads fail (the stub has no item
    /// endpoints), which shows the failure states.
    private func signedInTour(server: StubAPIServer) throws {
        app.launchEnvironment = try [
            "LISTORA_FIXTURE_PHOTOS": fixturesPath,
            "LISTORA_DEV_ACCESS_TOKEN": "stub-token",
            "LISTORA_DEV_API_BASE_URL": server.baseURL,
        ]
        app.launch()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 10))
        // The count heads the loaded list; at the largest text sizes the money summary is several
        // screens down.
        XCTAssertTrue(app.staticTexts["today.count"].waitForExistence(timeout: 10))
        try shot("00-today-signed-in")
        app.buttons["settings.open"].tap()
        app.buttons["settings.marketplaces"].tap()
        XCTAssertTrue(app.buttons["marketplaces.ebay.connect"].waitForExistence(timeout: 10))
        try shot("12-marketplaces")
        // Done is on the Settings screen, under Marketplaces.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["settings.done"].tap()

        // The stub has no item or sale endpoints, so both lists fail to load.
        tab("Inventory")
        try shot("36-inventory-unavailable", settle: 3)
        tab("Sales")
        try shot("37-sales-unavailable", settle: 3)

        tab("Add")
        XCTAssertTrue(app.buttons["draft.row"].waitForExistence(timeout: 5))
        try shot("13-drafts-upload-failed", settle: 3)
        app.buttons["draft.row"].tap()
        let tile = app.buttons["photo.tile.0"]
        // At the largest text sizes the failure banner fills the screen and the tiles start below it.
        if !tile.waitForExistence(timeout: 5) {
            app.swipeUp()
        }
        XCTAssertTrue(tile.waitForExistence(timeout: 5))
        try shot("14-draft-editor-upload-failed")
        app.terminate()
    }

    /// The guided capture with the fake camera (debug builds that have it).
    private func captureTour() throws {
        let takePhotos = app.buttons["addItem.takePhotos"]
        guard takePhotos.exists else { return }
        takePhotos.tap()
        let shutter = app.buttons["camera.shutter"]
        XCTAssertTrue(shutter.waitForExistence(timeout: 10))
        try shot("03-camera-front")
        shutter.tap()
        try shot("04-camera-back")
        app.buttons["camera.cancel"].tap()
        let discard = app.buttons["Discard photos"]
        if discard.waitForExistence(timeout: 5) {
            discard.tap()
        }
        XCTAssertTrue(app.staticTexts["Take photos once"].waitForExistence(timeout: 5))
        // Let the camera finish closing before the next tap.
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 1.5))
    }

    /// A draft from imported photos: the editor, a tag photo, and the crop screen.
    private func draftTour() throws {
        app.buttons["addItem.importPhotos"].tap()
        XCTAssertTrue(app.buttons["photo.tile.2"].waitForExistence(timeout: 15))
        try shot("05-draft-editor")

        app.buttons["photo.tile.2"].tap()
        XCTAssertTrue(app.buttons["photo.done"].waitForExistence(timeout: 5))
        let tag = app.buttons["photo.role.tag"]
        // At the largest text sizes the role chips start below the bottom bar.
        if !tag.isHittable || tag.frame.maxY > app.buttons["photo.crop"].frame.minY {
            app.scrollViews.firstMatch.swipeUp()
        }
        tag.tap()
        // Tag reading runs on the device and takes a few seconds in the simulator.
        let pending = app.descendants(matching: .any)["tagReading.pending"]
        let read = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: pending)
        _ = XCTWaiter().wait(for: [read], timeout: 60)
        try shot("06-photo-detail-tag")

        app.buttons["photo.crop"].tap()
        XCTAssertTrue(app.buttons["crop.done"].waitForExistence(timeout: 5))
        try shot("07-crop")
        app.buttons["Cancel"].tap()
        app.buttons["photo.done"].tap()

        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["draft.row"].waitForExistence(timeout: 5))
        try shot("08-drafts-offline")
    }

    func tab(_ title: String) {
        app.tabBars.buttons[title].tap()
    }

    /// Waits for animations and images to settle, then saves the screen.
    func shot(_ name: String, settle: TimeInterval = 1.5) throws {
        RunLoop.current.run(until: Date(timeIntervalSinceNow: settle))
        let screenshot = XCUIScreen.main.screenshot()
        let directory = try XCTUnwrap(directory)
        try screenshot.pngRepresentation.write(to: directory.appending(path: "\(name).png"))
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
