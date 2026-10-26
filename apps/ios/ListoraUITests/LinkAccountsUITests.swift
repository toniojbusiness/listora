import XCTest

/// Links Poshmark from Settings > Link accounts against `StubAPIServer`: the app opens a fake
/// marketplace's sign-in page in its own web view, the user signs in there, and the app hands
/// the stub API that site's session cookie, never the password. The marketplace shows as linked
/// only after the stub's check says so.
@MainActor
final class LinkAccountsUITests: XCTestCase {
    private let app = XCUIApplication()
    private var server: StubAPIServer?

    override func setUp() async throws {
        continueAfterFailure = false
    }

    override func tearDown() async throws {
        server?.stop()
    }

    /// Keeps a screenshot in the test results, for reviewing the screens.
    private func snapshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    func testLinksAMarketplaceBySigningInOnItsOwnPage() throws {
        let server = try StubAPIServer()
        try server.start()
        self.server = server
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_ACCESS_TOKEN": "ui-test-token",
            "LISTORA_DEV_API_BASE_URL": server.baseURL,
        ]
        app.launch()

        let settings = app.buttons["settings.open"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.tap()
        let linkAccounts = app.buttons["settings.linkAccounts"]
        XCTAssertTrue(linkAccounts.waitForExistence(timeout: 5), "no Link accounts\n\(app.debugDescription)")
        linkAccounts.tap()

        // Every marketplace linked by signing in, with the server's own status.
        let poshmarkStatus = element("linkAccounts.status.poshmark")
        XCTAssertTrue(poshmarkStatus.waitForExistence(timeout: 10), "no list\n\(app.debugDescription)")
        XCTAssertEqual(poshmarkStatus.label, "Not linked")
        XCTAssertEqual(element("linkAccounts.status.mercari").label, "Sign in again")
        XCTAssertEqual(
            element("linkAccounts.detail.mercari").label,
            "Mercari logged Listora out. Log in again.",
        )
        XCTAssertEqual(app.buttons["linkAccounts.link.mercari"].label, "Relink")
        XCTAssertEqual(element("linkAccounts.status.depop").label, "Not confirmed")
        XCTAssertEqual(
            element("linkAccounts.detail.depop").label,
            "Listora's browser didn't start, so it couldn't check your Depop sign-in. The problem is on "
                + "Listora's side, not Depop's. Check again, or link Depop again if it keeps failing.",
        )
        XCTAssertEqual(element("linkAccounts.status.ebay").label, "Not linked")
        snapshot("1-link-accounts")

        app.buttons["linkAccounts.link.poshmark"].tap()

        signInOnTheFakeMarketplace()

        // Linked only once the server's check passed.
        let linked = NSPredicate(format: "label == %@", "Linked")
        expectation(for: linked, evaluatedWith: poshmarkStatus)
        waitForExpectations(timeout: 20)
        snapshot("3-linked")
        XCTAssertEqual(app.buttons["linkAccounts.link.poshmark"].label, "Relink")

        try assertSentTheCookieButNotThePassword(server)
    }

    func testChecksASignInAgainWithoutSigningInAgain() throws {
        let server = try StubAPIServer()
        try server.start()
        self.server = server
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_ACCESS_TOKEN": "ui-test-token",
            "LISTORA_DEV_API_BASE_URL": server.baseURL,
        ]
        app.launch()

        let settings = app.buttons["settings.open"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.tap()
        app.buttons["settings.linkAccounts"].tap()

        let depopStatus = element("linkAccounts.status.depop")
        XCTAssertTrue(depopStatus.waitForExistence(timeout: 10), "no list\n\(app.debugDescription)")
        XCTAssertEqual(depopStatus.label, "Not confirmed")
        // The sign-in Listora holds may be fine: Check again needs no sign-in, Relink stays.
        let checkAgain = app.buttons["linkAccounts.checkAgain.depop"]
        XCTAssertTrue(checkAgain.exists)
        XCTAssertEqual(app.buttons["linkAccounts.link.depop"].label, "Relink")
        XCTAssertFalse(app.buttons["linkAccounts.checkAgain.poshmark"].exists)
        snapshot("1-not-confirmed")

        checkAgain.tap()

        let linked = NSPredicate(format: "label == %@", "Linked")
        expectation(for: linked, evaluatedWith: depopStatus)
        waitForExpectations(timeout: 20)
        snapshot("2-checked-again")
        XCTAssertFalse(app.webViews.firstMatch.exists, "Check again opened a sign-in page")
        let check = try XCTUnwrap(server.requests.first {
            $0.method == "POST" && $0.path == "/v1/connections/depop/checks"
        })
        XCTAssertNotNil(check.headers["idempotency-key"])
        let relinked = server.requests.contains { $0.method == "POST" && $0.path.hasPrefix("/v1/marketplace-sessions") }
        XCTAssertFalse(relinked, "Check again sent a new sign-in")
    }

    /// Signs in on the fake marketplace's page in the app's own web view, then taps
    /// "I'm signed in".
    private func signInOnTheFakeMarketplace() {
        let web = app.webViews.firstMatch
        let username = web.textFields.firstMatch
        XCTAssertTrue(username.waitForExistence(timeout: 20), "the sign-in page did not load\n\(app.debugDescription)")
        username.tap()
        username.typeText("closet_queen")
        let password = web.secureTextFields.firstMatch
        password.tap()
        password.typeText("hunter2-not-for-listora")
        snapshot("2-sign-in")
        web.buttons["Log in"].tap()
        XCTAssertTrue(
            web.staticTexts["Signed in as closet_queen"].waitForExistence(timeout: 15),
            "the fake marketplace did not sign in\n\(app.debugDescription)",
        )
        app.buttons["signIn.done"].tap()
    }

    /// The session cookie went to Listora; the password stayed with the marketplace's page.
    private func assertSentTheCookieButNotThePassword(_ server: StubAPIServer) throws {
        let link = try XCTUnwrap(server.requests.first {
            $0.method == "POST" && $0.path == "/v1/marketplace-sessions/poshmark"
        })
        XCTAssertNotNil(link.headers["idempotency-key"])
        XCTAssertTrue(link.body.contains(StubAPIServer.sessionCookieName), link.body)
        XCTAssertTrue(link.body.contains(StubAPIServer.sessionCookieValue), link.body)
        for request in server.requests where request.path.hasPrefix("/v1/") {
            XCTAssertFalse(request.body.contains("hunter2"), "\(request.path) carried the password")
        }
        XCTAssertGreaterThanOrEqual(
            server.requests.count { $0.method == "GET" && $0.path == "/v1/marketplace-sessions/poshmark" },
            2,
        )
    }
}
