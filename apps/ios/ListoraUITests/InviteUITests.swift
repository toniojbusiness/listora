import XCTest

/// Invites against `StubAPIServer` (docs/features/invites.md): an invitee signs up with the code
/// and their own email, then the emailed code; one whose address waits for its verification link is
/// told so first; and the owner invites someone and turns off a person's access in Settings > People.
@MainActor
final class InviteUITests: XCTestCase {
    private let app = XCUIApplication()
    private var server: StubAPIServer?

    override func setUp() async throws {
        continueAfterFailure = false
        let server = try StubAPIServer()
        try server.start()
        self.server = server
    }

    override func tearDown() async throws {
        server?.stop()
    }

    private func launchSignedOut() throws {
        let server = try XCTUnwrap(server)
        app.launchEnvironment = ["LISTORA_RESET_LOCAL_DATA": "1", "LISTORA_DEV_API_BASE_URL": server.baseURL]
        app.launchQuietly()
    }

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    /// Opens the sign-up from the welcome screen and enters the code and the email.
    private func enterInvite(email: String) {
        let signUp = app.buttons["signIn.invite"]
        XCTAssertTrue(signUp.waitForExistence(timeout: 10), "no invite sign-up on the welcome screen")
        if !signUp.isHittable {
            app.swipeUp()
        }
        signUp.tap()
        let code = app.textFields["invite.code"]
        XCTAssertTrue(code.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["invite.continue"].isEnabled, "Continue needs the code and the email")
        code.tap()
        code.typeText(StubAPIServer.inviteCode.lowercased())
        let field = app.textFields["invite.email"]
        field.tap()
        field.typeText(email)
        keepScreenshot("Sign up with an invite")
    }

    func testSignsUpWithTheInviteAndTheEmailedCode() throws {
        try launchSignedOut()
        enterInvite(email: StubAPIServer.invitee)
        app.buttons["invite.continue"].tap()

        // The invite is the email's: the usual code screen, for that address.
        let code = app.textFields["signIn.code"]
        XCTAssertTrue(code.waitForExistence(timeout: 10), "no code screen after redeeming")
        XCTAssertTrue(app.staticTexts["signIn.sentTo"].label.contains(StubAPIServer.invitee))
        code.typeText(StubAPIServer.devSignInCode)
        app.buttons["signIn.signIn"].tap()
        XCTAssertTrue(app.buttons["gettingStarted.skip"].waitForExistence(timeout: 10), "not signed in")

        let server = try XCTUnwrap(server)
        let redemption = try XCTUnwrap(server.requests.last { $0.path == "/v1/invite-redemptions" })
        XCTAssertNil(redemption.headers["authorization"], "redeeming needs no session")
        XCTAssertTrue(redemption.body.contains(StubAPIServer.invitee), redemption.body)
    }

    func testSaysToVerifyTheAddressFirstThenCarriesOn() throws {
        try launchSignedOut()
        enterInvite(email: StubAPIServer.unverifiedInvitee)
        app.buttons["invite.continue"].tap()

        let verification = element("invite.verification")
        XCTAssertTrue(verification.waitForExistence(timeout: 10))
        XCTAssertTrue(verification.label.contains("Amazon Web Services"), verification.label)
        XCTAssertFalse(app.textFields["signIn.code"].exists, "no sign-in code before the address is verified")
        keepScreenshot("Verify your email first")

        app.buttons["invite.continue"].tap()
        XCTAssertTrue(app.textFields["signIn.code"].waitForExistence(timeout: 10))
    }

    func testAWrongCodeSaysSo() throws {
        try launchSignedOut()
        let signUp = app.buttons["signIn.invite"]
        XCTAssertTrue(signUp.waitForExistence(timeout: 10))
        signUp.tap()
        let code = app.textFields["invite.code"]
        XCTAssertTrue(code.waitForExistence(timeout: 5))
        code.tap()
        code.typeText("ZZZZ-ZZZZ-ZZZZ-ZZZZ")
        let field = app.textFields["invite.email"]
        field.tap()
        field.typeText(StubAPIServer.invitee)
        app.buttons["invite.continue"].tap()
        let message = element("invite.message")
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        XCTAssertEqual(message.label, "That invite code isn't right. Check it and try again.")
        XCTAssertFalse(app.textFields["signIn.code"].exists)
    }

    /// Signed in as the owner, Settings > People.
    private func openPeople() throws {
        let server = try XCTUnwrap(server)
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_ACCESS_TOKEN": "ui-test-token",
            "LISTORA_DEV_ACCESS_EMAIL": StubAPIServer.profileEmail,
            "LISTORA_DEV_API_BASE_URL": server.baseURL,
        ]
        app.launchQuietly()
        let settings = app.buttons["settings.open"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.tap()
        let people = app.buttons["settings.people"]
        for _ in 0 ..< 6 where !(people.exists && people.isHittable) {
            app.collectionViews.firstMatch.swipeUp()
        }
        XCTAssertTrue(people.waitForExistence(timeout: 5), "no People row for the owner")
        XCTAssertTrue(people.label.contains("1 person joined"), people.label)
        people.tap()
    }

    func testTheOwnerInvitesSomeoneAndTurnsOffAPersonsAccess() throws {
        let server = try XCTUnwrap(server)
        try openPeople()
        XCTAssertTrue(app.navigationBars["People"].waitForExistence(timeout: 5))
        let maria = element("invites.row.H8RA")
        XCTAssertTrue(maria.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts[StubAPIServer.invitee].exists)
        XCTAssertTrue(app.staticTexts["Active"].exists)
        XCTAssertTrue(app.staticTexts["Not used yet"].exists)
        keepScreenshot("People")

        // A new invite: its code, shown once, to copy or share.
        app.buttons["invites.new"].tap()
        let label = app.textFields["invites.label"]
        XCTAssertTrue(label.waitForExistence(timeout: 5))
        label.tap()
        label.typeText("Sam")
        keepScreenshot("Invite someone")
        app.buttons["invites.create"].tap()
        let code = element("invites.code")
        XCTAssertTrue(code.waitForExistence(timeout: 10))
        XCTAssertEqual(code.label, "Invite code")
        XCTAssertTrue(app.buttons["invites.share"].exists)
        XCTAssertTrue(app.buttons["invites.copy"].exists)
        keepScreenshot("Share the invite")
        let create = try XCTUnwrap(server.requests.last { $0.method == "POST" && $0.path == "/v1/invites" })
        let sent = create.body.filter { !$0.isWhitespace }
        XCTAssertTrue(sent.contains(#""label":"Sam""#), create.body)
        XCTAssertTrue(sent.contains(#""expiresInDays":7"#), create.body)
        app.buttons["invites.sheet.done"].tap()
        XCTAssertTrue(element("invites.row.W3MC").waitForExistence(timeout: 5), "the new invite is listed")

        // Turning off Maria's access asks first, then shows the server's state.
        maria.buttons["invites.revoke"].tap()
        let confirm = app.buttons["invites.revoke.confirm"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(app.staticTexts["Access turned off"].waitForExistence(timeout: 10))
        XCTAssertTrue(maria.buttons["invites.restore"].waitForExistence(timeout: 5))
        keepScreenshot("Access turned off")
    }

    /// Keeps a screenshot in the result bundle, passing or not, for reviewing the screens.
    private func keepScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
