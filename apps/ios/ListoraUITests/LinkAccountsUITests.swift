import XCTest

/// Links Poshmark from Settings > Link accounts against `StubAPIServer`: the app opens a fake
/// marketplace's sign-in page in its own web view, the user signs in there, and the app hands
/// the stub API that site's session cookie, never the password. The marketplace shows as linked
/// only after the stub's check says so. A linked marketplace unlinks after a confirmation.
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

    /// A linked Poshmark is unlinked after a confirmation, and shows as not linked once the stub
    /// API unlinked it. It starts linked, so it needs no sign-in page.
    func testUnlinksAMarketplaceAfterAConfirmation() throws {
        let server = try StubAPIServer()
        try server.start()
        server.linkPoshmark()
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

        let poshmarkStatus = element("linkAccounts.status.poshmark")
        XCTAssertTrue(poshmarkStatus.waitForExistence(timeout: 10), "no list\n\(app.debugDescription)")
        XCTAssertEqual(poshmarkStatus.label, "Linked")
        // Nothing to unlink where nothing is linked.
        XCTAssertFalse(app.buttons["linkAccounts.unlink.ebay"].exists)

        app.buttons["linkAccounts.unlink.poshmark"].tap()
        let confirm = app.buttons["linkAccounts.confirmUnlink"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "no confirmation\n\(app.debugDescription)")
        XCTAssertFalse(server.requests.contains { $0.method == "DELETE" })
        snapshot("1-unlink-confirmation")
        confirm.tap()

        expectation(for: NSPredicate(format: "label == %@", "Not linked"), evaluatedWith: poshmarkStatus)
        waitForExpectations(timeout: 10)
        XCTAssertEqual(app.buttons["linkAccounts.link.poshmark"].label, "Link")
        XCTAssertFalse(app.buttons["linkAccounts.unlink.poshmark"].exists)
        XCTAssertEqual(
            server.requests.count { $0.method == "DELETE" && $0.path == "/v1/connections/poshmark" },
            1,
        )
        snapshot("2-unlinked")
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

    /// Settings > Sale emails: the account's own forwarding address, Gmail's confirmation code to
    /// copy, and the setup steps.
    func testShowsTheSaleEmailAddressAndConfirmation() throws {
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
        let saleEmails = app.buttons["settings.saleEmails"]
        XCTAssertTrue(saleEmails.waitForExistence(timeout: 5), "no Sale emails\n\(app.debugDescription)")
        saleEmails.tap()

        let list = app.collectionViews.firstMatch
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        // A list builds only the rows on screen: scroll each one into view before reading it.
        func reveal(_ target: XCUIElement) {
            for _ in 0 ..< 6 where !(target.exists && target.isHittable) {
                list.swipeUp()
            }
        }
        let status = element("saleEmails.status")
        reveal(status)
        XCTAssertTrue(status.waitForExistence(timeout: 10), "no sale emails\n\(app.debugDescription)")
        XCTAssertEqual(status.label, "Confirm forwarding")
        let address = element("saleEmails.address")
        reveal(address)
        XCTAssertEqual(address.label, StubAPIServer.forwardingAddress)
        let confirmation = element("saleEmails.confirmation")
        reveal(confirmation)
        XCTAssertTrue(confirmation.exists)
        let code = element("saleEmails.code")
        reveal(code)
        XCTAssertEqual(code.label, StubAPIServer.forwardingCode)
        let link = app.buttons["saleEmails.confirmationLink"]
        reveal(link)
        XCTAssertTrue(link.exists)
        snapshot("4-sale-emails")

        let copyCode = app.buttons["saleEmails.copy.code"]
        copyCode.tap()
        // The label changes once the copy has gone through, a moment after the tap on CI.
        let copied = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "Confirmation code copied"),
            object: copyCode,
        )
        XCTAssertEqual(XCTWaiter().wait(for: [copied], timeout: 5), .completed, copyCode.label)
    }

    /// Settings > Notifications: "Ask before delisting", saved on the server.
    func testSavesAskBeforeDelistingOnTheServer() throws {
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
        app.buttons["settings.notifications"].tap()
        let ask = app.switches["saleEmails.askBeforeDelist"]
        XCTAssertTrue(ask.waitForExistence(timeout: 10), "no setting\n\(app.debugDescription)")
        XCTAssertEqual(ask.value as? String, "0")
        // The control itself, at the row's trailing edge (a tap on the label does not toggle it).
        ask.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        let saved = NSPredicate(format: "value == %@", "1")
        expectation(for: saved, evaluatedWith: ask)
        waitForExpectations(timeout: 10)
        let put = try XCTUnwrap(server.requests.last { $0.method == "PUT" && $0.path == "/v1/sale-emails/settings" })
        XCTAssertTrue(put.body.replacingOccurrences(of: " ", with: "").contains(#""askBeforeDelist":true"#), put.body)
        snapshot("5-ask-before-delisting")
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
