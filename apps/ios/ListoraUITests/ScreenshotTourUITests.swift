import XCTest

/// Visits every screen and saves a screenshot of each, for design reviews (`make ios-screenshots`,
/// which runs it once per appearance and text size). It runs only when the test runner has
/// `LISTORA_SCREENSHOT_DIR` (from `TEST_RUNNER_LISTORA_SCREENSHOT_DIR`), so `make ios-test` skips it.
///
/// The screenshots land in `<dir>/<LISTORA_SCREENSHOT_VARIANT>/NN-screen.png`. The API is
/// `StubAPIServer`; the first pass is signed out, as on a fresh install.
@MainActor
final class ScreenshotTourUITests: XCTestCase {
    private let app = XCUIApplication()
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
        try signedOutTour()
        try signedInTour(server: XCTUnwrap(server))
    }

    /// Signed out, as on a fresh install: drafts stay on the phone.
    private func signedOutTour() throws {
        app.launchEnvironment = try [
            "LISTORA_FIXTURE_PHOTOS": fixturesPath,
            "LISTORA_FAKE_CAMERA": fixturesPath,
            "LISTORA_RESET_LOCAL_DATA": "1",
        ]
        app.launch()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 10))
        try shot("00-today-signed-out")

        tab("Inventory")
        try shot("01-inventory")

        tab("Add")
        XCTAssertTrue(app.buttons["addItem.importPhotos"].waitForExistence(timeout: 5))
        try shot("02-add-item")

        try captureTour()
        try draftTour()

        tab("Tasks")
        try shot("09-tasks")

        tab("Today")
        app.buttons["settings.open"].tap()
        XCTAssertTrue(app.buttons["settings.marketplaces"].waitForExistence(timeout: 5))
        try shot("10-settings")

        // Nothing answers at the Dev API, so the list cannot load.
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
        XCTAssertTrue(app.descendants(matching: .any)["today.money.sales"].waitForExistence(timeout: 10))
        try shot("15-today")
        app.buttons["settings.open"].tap()
        app.buttons["settings.marketplaces"].tap()
        XCTAssertTrue(app.buttons["marketplaces.ebay.connect"].waitForExistence(timeout: 10))
        try shot("12-marketplaces")
        app.buttons["settings.done"].tap()

        tab("Add")
        XCTAssertTrue(app.buttons["draft.row"].waitForExistence(timeout: 5))
        try shot("13-drafts-upload-failed", settle: 3)
        app.buttons["draft.row"].tap()
        XCTAssertTrue(app.buttons["photo.tile.0"].waitForExistence(timeout: 5))
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
        try shot("08-drafts-signed-out")
    }

    private func tab(_ title: String) {
        app.tabBars.buttons[title].tap()
    }

    /// Waits for animations and images to settle, then saves the screen.
    private func shot(_ name: String, settle: TimeInterval = 1.5) throws {
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
