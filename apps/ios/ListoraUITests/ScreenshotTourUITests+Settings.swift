import XCTest

/// Profile and settings against the stub, with a seller who entered their name and business: the
/// avatar in the Today header, Settings, the profile, notifications and delisting, sale emails,
/// help, the privacy policy, and the hidden Diagnostics.
extension ScreenshotTourUITests {
    func testSettingsTour() throws {
        let server = try StubAPIServer()
        try server.start()
        defer { server.stop() }
        server.profileNames = ["displayName": "Sam Rivera", "businessName": "Second Spin Vintage"]
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_ACCESS_TOKEN": "stub-token",
            "LISTORA_DEV_ACCESS_EMAIL": StubAPIServer.profileEmail,
            "LISTORA_DEV_API_BASE_URL": server.baseURL,
        ]
        app.launchQuietly()
        XCTAssertTrue(app.buttons["settings.open"].waitForExistence(timeout: 10))
        try shot("50-today-header", settle: 3)
        app.buttons["settings.open"].tap()
        XCTAssertTrue(app.staticTexts["settings.profile.name"].waitForExistence(timeout: 10))
        try shot("51-settings", settle: 2)
        app.swipeUp()
        try shot("52-settings-bottom", settle: 2)
        app.swipeDown()

        app.buttons["settings.profile"].tap()
        XCTAssertTrue(app.textFields["profile.name"].waitForExistence(timeout: 5))
        try shot("53-profile")
        back()

        app.buttons["settings.notifications"].tap()
        XCTAssertTrue(app.switches["saleEmails.askBeforeDelist"].waitForExistence(timeout: 10))
        try shot("54-notifications")
        back()

        app.buttons["settings.saleEmails"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["saleEmails.status"].waitForExistence(timeout: 10))
        try shot("55-sale-emails")
        back()

        reveal(app.buttons["settings.help"]).tap()
        XCTAssertTrue(app.navigationBars["Help and contact"].waitForExistence(timeout: 5))
        try shot("56-help")
        back()

        reveal(app.buttons["settings.privacy"]).tap()
        XCTAssertTrue(app.descendants(matching: .any)["legal.privacy-policy"].waitForExistence(timeout: 5))
        try shot("57-privacy-policy")
        back()

        let version = reveal(app.descendants(matching: .any)["settings.version"])
        version.press(forDuration: 1.2)
        XCTAssertTrue(app.navigationBars["Diagnostics"].waitForExistence(timeout: 5))
        try shot("58-diagnostics")
        app.terminate()
    }

    private func back() {
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    /// Scrolls Settings until the element can be tapped.
    private func reveal(_ element: XCUIElement) -> XCUIElement {
        for _ in 0 ..< 6 where !(element.exists && element.isHittable) {
            app.swipeUp()
        }
        return element
    }
}
