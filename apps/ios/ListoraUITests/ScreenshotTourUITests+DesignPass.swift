import XCTest

/// The design pass's new screens: the first-run guide's three steps, and a photo before and after
/// its background cleanup.
extension ScreenshotTourUITests {
    func testDesignPassTour() throws {
        let haul = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "BatchFixtures", withExtension: nil))
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_SHOW_GETTING_STARTED": "1",
            "LISTORA_FIXTURE_PHOTOS": haul.path(percentEncoded: false),
        ]
        app.launch()
        XCTAssertTrue(app.buttons["gettingStarted.skip"].waitForExistence(timeout: 10))
        try shot("40-welcome-link")
        app.buttons["gettingStarted.continue"].tap()
        try shot("41-welcome-add")
        app.buttons["gettingStarted.continue"].tap()
        try shot("42-welcome-listed")
        app.buttons["gettingStarted.skip"].tap()

        tab("Add")
        let importButton = app.buttons["addItem.importPhotos"]
        XCTAssertTrue(importButton.waitForExistence(timeout: 5))
        importButton.tap()
        let cover = app.buttons["photo.tile.0"]
        XCTAssertTrue(cover.waitForExistence(timeout: 30))
        cover.tap()
        let clean = app.buttons["photo.cleanBackground"]
        XCTAssertTrue(clean.waitForExistence(timeout: 5))
        try shot("43-photo-before-cleanup")
        clean.tap()
        XCTAssertTrue(app.buttons["photo.undoCleanup"].waitForExistence(timeout: 30))
        try shot("44-photo-cleaned")
        app.terminate()
    }
}
