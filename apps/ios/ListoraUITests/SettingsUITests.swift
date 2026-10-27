import XCTest

/// Settings against `StubAPIServer`: the profile (names saved on the server, the email read-only),
/// only what a seller needs in the list, the build's details behind a long press on the version,
/// and the help and legal screens.
@MainActor
final class SettingsUITests: XCTestCase {
    private let app = XCUIApplication()
    private var server: StubAPIServer?

    override func setUp() async throws {
        continueAfterFailure = false
        let server = try StubAPIServer()
        try server.start()
        self.server = server
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_ACCESS_TOKEN": "ui-test-token",
            "LISTORA_DEV_ACCESS_EMAIL": StubAPIServer.profileEmail,
            "LISTORA_DEV_API_BASE_URL": server.baseURL,
        ]
        app.launch()
    }

    override func tearDown() async throws {
        server?.stop()
    }

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    /// Scrolls Settings until the row is built and clear of the screen's bottom edge: a list
    /// builds only what it shows. Hittable is not enough: a row half under the bottom edge is
    /// hittable, and on CI the tap at its middle (the home indicator's strip) closed the sheet.
    private func reveal(_ target: XCUIElement) -> XCUIElement {
        let bottom = app.windows.firstMatch.frame.maxY - 100
        for _ in 0 ..< 6 where !(target.exists && target.isHittable && target.frame.maxY < bottom) {
            app.collectionViews.firstMatch.swipeUp()
        }
        return target
    }

    private func openSettings() {
        let settings = app.buttons["settings.open"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
    }

    func testEditsTheNameAndBusinessNameAndSavesThemOnTheServer() throws {
        let server = try XCTUnwrap(server)
        openSettings()
        XCTAssertEqual(element("signIn.signedInEmail").value as? String, StubAPIServer.profileEmail)
        let name = element("settings.profile.name")
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        XCTAssertEqual(name.label, "Add your name")

        app.buttons["settings.profile"].tap()
        XCTAssertTrue(app.navigationBars["Profile"].waitForExistence(timeout: 5))
        // The email signs in, so it only reads.
        XCTAssertTrue(element("profile.email").label.contains(StubAPIServer.profileEmail))
        XCTAssertFalse(app.buttons["profile.save"].isEnabled, "nothing changed yet")
        let nameField = app.textFields["profile.name"]
        nameField.tap()
        nameField.typeText("Sam Rivera")
        let businessField = app.textFields["profile.businessName"]
        businessField.tap()
        businessField.typeText("Second Spin Vintage")
        app.buttons["profile.save"].tap()

        // Back on Settings once the server has it.
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        XCTAssertEqual(name.label, "Sam Rivera")
        XCTAssertEqual(element("settings.profile.businessName").label, "Second Spin Vintage")
        let put = try XCTUnwrap(server.requests.last { $0.method == "PUT" && $0.path == "/v1/account/profile" })
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(put.body.utf8)) as? [String: String])
        XCTAssertEqual(sent, ["displayName": "Sam Rivera", "businessName": "Second Spin Vintage"])
    }

    func testShowsOnlyWhatASellerNeedsAndHidesTheBuildsDetails() {
        openSettings()
        for row in [
            "settings.linkAccounts",
            "settings.marketplaces",
            "settings.notifications",
            "settings.saleEmails",
            "settings.people",
            "settings.help",
            "settings.privacy",
            "settings.terms",
            "signIn.signOut",
            "settings.deleteAccount",
        ] {
            XCTAssertTrue(reveal(app.buttons[row]).exists, "no \(row)\n\(app.debugDescription)")
        }
        // No server address, environment, or other developer detail in the list.
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'http'")).firstMatch.exists)
        XCTAssertFalse(app.staticTexts["Environment"].exists)
        XCTAssertFalse(app.staticTexts["Dev"].exists)

        // The version, in plain words; a long press opens Diagnostics for support.
        let version = reveal(element("settings.version"))
        XCTAssertTrue(version.label.hasPrefix("Listora "), version.label)
        XCTAssertFalse(version.label.contains("("), "the build number stays in Diagnostics")
        version.press(forDuration: 1.2)
        XCTAssertTrue(app.navigationBars["Diagnostics"].waitForExistence(timeout: 5))
        // Each row reads as its label, then its value.
        XCTAssertEqual(element("diagnostics.environment").label, "Environment, Dev")
        let address = element("diagnostics.apiBaseURL").label
        XCTAssertTrue(address.hasPrefix("Server, http://"), address)
    }

    func testOpensHelpThePrivacyPolicyAndTheTerms() {
        openSettings()
        reveal(app.buttons["settings.help"]).tap()
        XCTAssertTrue(app.navigationBars["Help and contact"].waitForExistence(timeout: 5))
        // Dev names no support address.
        XCTAssertTrue(element("help.noContact").exists)
        XCTAssertTrue(app.goBack(from: "Help and contact"), "Help did not close\n\(app.debugDescription)")

        reveal(app.buttons["settings.privacy"]).tap()
        XCTAssertTrue(element("legal.privacy-policy").waitForExistence(timeout: 5), "\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts["Summary"].exists)
        XCTAssertTrue(app.goBack(from: "Privacy policy"), "the privacy policy did not close")

        reveal(app.buttons["settings.terms"]).tap()
        XCTAssertTrue(element("legal.terms-of-service").waitForExistence(timeout: 5))
    }
}
