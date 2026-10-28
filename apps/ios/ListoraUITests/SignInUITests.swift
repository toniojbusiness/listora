import UIKit
import XCTest

/// Drives the signed-out app on the simulator: a fresh launch opens the welcome screen with no
/// tabs, the email and the code (typed, then pasted) sign in through the dev sign-in of
/// `StubAPIServer`, and signing out from Settings comes back to the welcome screen.
@MainActor
final class SignInUITests: XCTestCase {
    private let app = XCUIApplication()
    private var server: StubAPIServer?

    override func setUp() async throws {
        continueAfterFailure = false
        let server = try StubAPIServer()
        try server.start()
        self.server = server
        // Signed out and without drafts, whatever an earlier test left behind.
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": server.baseURL,
        ]
        app.launch()
    }

    override func tearDown() async throws {
        server?.stop()
    }

    private var welcome: XCUIElement {
        app.descendants(matching: .any)["signIn.welcome"]
    }

    private func requestCode(for email: String) {
        let field = app.textFields["signIn.email"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(email)
        let next = app.buttons["signIn.continue"]
        XCTAssertTrue(next.isEnabled)
        next.tap()
        XCTAssertTrue(app.staticTexts["Enter the code"].waitForExistence(timeout: 10), "no code screen")
    }

    func testSignedOutLaunchSignsInWithACodeAndSignsOutBackToWelcome() throws {
        // The welcome screen is the root: the name, the value statement, and no tabs.
        XCTAssertTrue(welcome.waitForExistence(timeout: 10))
        XCTAssertEqual(app.descendants(matching: .any)["signIn.wordmark"].label, "Listora")
        XCTAssertTrue(app.staticTexts["signIn.valueStatement"].exists)
        XCTAssertFalse(app.tabRail.exists, "the tabs show only once signed in")
        XCTAssertFalse(app.buttons["signIn.continue"].isEnabled, "Continue needs an email")

        requestCode(for: "seller@listora.test")
        XCTAssertTrue(app.staticTexts["signIn.sentTo"].label.contains("seller@listora.test"))
        let resend = app.buttons["signIn.resend"]
        XCTAssertTrue(resend.label.hasPrefix("Send a new code in 0:"), resend.label)
        XCTAssertFalse(resend.isEnabled, "a new code waits for the cooldown")
        XCTAssertTrue(app.buttons["signIn.paste"].exists)

        // A wrong code says so and empties the field.
        let code = app.textFields["signIn.code"]
        code.typeText("000000")
        app.buttons["signIn.signIn"].tap()
        let message = app.descendants(matching: .any)["signIn.message"]
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        XCTAssertEqual(message.label, "That sign-in code is not correct.")
        XCTAssertNotEqual(code.value as? String, "000000", "the wrong code is cleared")
        XCTAssertFalse(app.tabRail.exists)

        // The right code opens the app on Today, with the first-run guide over it the first time.
        code.typeText(StubAPIServer.devSignInCode)
        app.buttons["signIn.signIn"].tap()
        let skipGuide = app.buttons["gettingStarted.skip"]
        XCTAssertTrue(skipGuide.waitForExistence(timeout: 10), "the first sign-in shows the getting-started guide")
        XCTAssertTrue(app.staticTexts["Link your marketplaces"].exists)
        skipGuide.tap()
        let tabBar = app.tabRail
        XCTAssertTrue(tabBar.waitForExistence(timeout: 10), "signing in shows the tabs")
        XCTAssertTrue(tabBar.buttons["Today"].isSelected)
        XCTAssertTrue(app.staticTexts["today.count"].waitForExistence(timeout: 10), "Today loads signed in")
        let session = try XCTUnwrap(server?.requests.last { $0.path == "/dev/auth/sessions" })
        XCTAssertTrue(session.body.contains("seller@listora.test"), session.body)

        // Settings shows who is signed in; signing out goes back to the welcome screen.
        app.buttons["settings.open"].tap()
        let email = app.staticTexts["signIn.signedInEmail"]
        XCTAssertTrue(email.waitForExistence(timeout: 5))
        XCTAssertEqual(email.value as? String, "seller@listora.test")
        // Sign out is near the bottom of Settings, which builds only the rows on screen.
        let signOut = app.buttons["signIn.signOut"]
        for _ in 0 ..< 6 where !(signOut.exists && signOut.isHittable) {
            app.collectionViews.firstMatch.swipeUp()
        }
        signOut.tap()
        XCTAssertTrue(welcome.waitForExistence(timeout: 10))
        XCTAssertFalse(tabBar.exists)
    }

    func testAPastedCodeSignsInWithoutATap() {
        XCTAssertTrue(welcome.waitForExistence(timeout: 10))
        requestCode(for: "seller@listora.test")

        // The simulator's pasteboard is the test runner's too; PasteButton reads it without asking.
        UIPasteboard.general.string = "Your Listora code: \(StubAPIServer.devSignInCode)"
        app.buttons["signIn.paste"].tap()

        XCTAssertTrue(app.tabRail.waitForExistence(timeout: 10), "the pasted code signs in")
    }

    func testDifferentEmailGoesBackToTheWelcomeScreen() {
        XCTAssertTrue(welcome.waitForExistence(timeout: 10))
        requestCode(for: "seller@listora.test")

        app.buttons["signIn.differentEmail"].tap()

        XCTAssertTrue(app.buttons["signIn.continue"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.textFields["signIn.code"].exists)
    }
}
