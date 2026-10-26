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
            "settings.help",
            "settings.privacy",
            "settings.terms",
            "signIn.signOut",
            "settings.deleteAccount",
        ] {
            let target = app.buttons[row]
            for _ in 0 ..< 4 where !target.exists {
                app.swipeUp()
            }
            XCTAssertTrue(target.exists, "no \(row)\n\(app.debugDescription)")
        }
        // No server address, environment, or other developer detail in the list.
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'http'")).firstMatch.exists)
        XCTAssertFalse(app.staticTexts["Environment"].exists)
        XCTAssertFalse(app.staticTexts["Dev"].exists)

        // The version, in plain words; a long press opens Diagnostics for support.
        let version = element("settings.version")
        for _ in 0 ..< 4 where !version.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(version.label.hasPrefix("Listora "), version.label)
        XCTAssertFalse(version.label.contains("("), "the build number stays in Diagnostics")
        version.press(forDuration: 1.2)
        XCTAssertTrue(app.navigationBars["Diagnostics"].waitForExistence(timeout: 5))
        XCTAssertEqual(element("diagnostics.environment").label, "Dev")
        let address = element("diagnostics.apiBaseURL").label
        XCTAssertTrue(address.hasPrefix("http://"), address)
    }

    func testOpensHelpThePrivacyPolicyAndTheTerms() {
        openSettings()
        let help = app.buttons["settings.help"]
        for _ in 0 ..< 4 where !help.isHittable {
            app.swipeUp()
        }
        help.tap()
        XCTAssertTrue(app.navigationBars["Help and contact"].waitForExistence(timeout: 5))
        // Dev names no support address.
        XCTAssertTrue(element("help.noContact").exists)
        app.navigationBars.buttons.element(boundBy: 0).tap()

        app.buttons["settings.privacy"].tap()
        XCTAssertTrue(element("legal.privacy-policy").waitForExistence(timeout: 5), "\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts["Summary"].exists)
        app.navigationBars.buttons.element(boundBy: 0).tap()

        app.buttons["settings.terms"].tap()
        XCTAssertTrue(element("legal.terms-of-service").waitForExistence(timeout: 5))
    }
}
