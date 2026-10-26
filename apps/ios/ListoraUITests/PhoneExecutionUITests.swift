import XCTest

/// Depop runs on this iPhone (docs/features/phone-execution.md), against the local stack: the
/// app links Depop on the stack's fake Depop site, and the stack hands this phone the work of
/// that marketplace. The app's runtime runs each step in an off-screen web view in the seller's
/// own session; the server decides every result from what the phone reports.
@MainActor
final class PhoneExecutionUITests: XCTestCase {
    private let app = XCUIApplication()
    private var stack: E2EStack?

    override func setUp() async throws {
        continueAfterFailure = false
    }

    override func tearDown() async throws {
        try await stack?.clearDepopChecks()
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

    func testLinksDepopAndChecksTheSessionOnThisIPhone() async throws {
        let stack = try await freshStack()
        launch(stack, reset: true)
        openLinkAccounts()

        try await link()

        // The check ran here, so the row says so, and nothing asks to sign in again. The first
        // sale check waits for the phone too, until the phone has run it.
        let runsOn = element("linkAccounts.runsOn.depop")
        let ranEverything = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "Runs on this iPhone"),
            object: runsOn,
        )
        await fulfillment(of: [ranEverything], timeout: 60)
        XCTAssertFalse(app.buttons["linkAccounts.checkAgain.depop"].exists)
        snapshot("1-linked-on-this-iphone")
    }

    func testHandsABotCheckToTheSellerAndGoesOnOnceTheyAreDone() async throws {
        let stack = try await freshStack()
        launch(stack, reset: true)
        openLinkAccounts()

        // Depop shows a bot check when the phone opens the selling hub to check the session.
        try await link(waitForLinked: false) {
            try await stack.injectDepopCheck(action: "health", type: "bot_check")
        }

        let banner = element("handOff.banner")
        XCTAssertTrue(banner.waitForExistence(timeout: 60), "no hand-off\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts["Depop wants to check it's you"].exists)
        XCTAssertTrue(
            app.webViews.staticTexts["Please verify you are a human"].waitForExistence(timeout: 10),
            "the hand-off shows another page\n\(app.debugDescription)",
        )
        snapshot("1-bot-check-handed-off")

        // The seller completes the check themselves and taps Done; the run goes on from there.
        app.buttons["handOff.done"].tap()

        await waitForLinked()
        XCTAssertFalse(banner.exists)
        XCTAssertTrue(element("linkAccounts.runsOn.depop").label.hasPrefix("Runs on this iPhone"))
        snapshot("2-linked-after-the-check")
    }

    func testListsAndEndsADepopListingFromThisIPhone() async throws {
        let stack = try await freshStack()
        launch(stack, reset: true)
        openLinkAccounts()
        try await link()
        app.terminate()

        // With the app closed, the publish waits on the phone, and says so.
        let seeded = try await stack.seedQueuedDepopListing()
        let before = try await stack.depopProducts().count
        try await waitFor("the publish to wait on the phone") {
            try await stack.listing(id: seeded.listingId).statusDisplay.label.contains("waiting on your iPhone")
        }

        // Opening the app runs it: the listing goes live on Depop, in the seller's session here.
        launch(stack, reset: false)
        try await waitFor("the listing to go live", timeout: 120) {
            try await stack.listing(id: seeded.listingId).status == "active"
        }
        let products = try await stack.depopProducts()
        XCTAssertEqual(products.count, before + 1)
        let product = try XCTUnwrap(products.last)
        XCTAssertEqual(product.status, "ONSALE")
        XCTAssertEqual(product.priceCents, 4500)
        snapshot("1-listed-from-this-iphone")

        // Ending it waits for the phone too; coming back to the app runs it.
        try await stack.endListing(id: seeded.listingId)
        XCUIDevice.shared.press(.home)
        app.activate()
        try await waitFor("the listing to end", timeout: 120) {
            try await stack.listing(id: seeded.listingId).status == "ended"
        }
        let ended = try await stack.depopProducts().first { $0.slug == product.slug }
        XCTAssertEqual(ended?.status, "DELETED")
    }

    /// The local stack, with Depop unlinked: no session, and no work waiting for a phone that
    /// an earlier test linked it on.
    private func freshStack() async throws -> E2EStack {
        let stack = try E2EStack.fromEnvironment()
        self.stack = stack
        try await stack.clearDepopChecks()
        try await stack.unlink("depop")
        return stack
    }

    private func launch(_ stack: E2EStack, reset: Bool) {
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": reset ? "1" : "0",
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": stack.token,
            "LISTORA_DEV_ACCESS_EMAIL": stack.email,
        ]
        app.launch()
    }

    private func openLinkAccounts() {
        let settings = app.buttons["settings.open"]
        XCTAssertTrue(settings.waitForExistence(timeout: 30), "no Settings\n\(app.debugDescription)")
        settings.tap()
        let linkAccounts = app.buttons["settings.linkAccounts"]
        XCTAssertTrue(linkAccounts.waitForExistence(timeout: 20), "no Link accounts\n\(app.debugDescription)")
        linkAccounts.tap()
        XCTAssertTrue(
            element("linkAccounts.status.depop").waitForExistence(timeout: 20),
            "no Depop row\n\(app.debugDescription)",
        )
    }

    /// Signs in on the fake Depop in the app's sign-in page, runs `before` once signed in, and
    /// hands the session over; then waits until the phone's check says Linked.
    private func link(
        waitForLinked: Bool = true,
        before: () async throws -> Void = {},
    ) async throws {
        app.buttons["linkAccounts.link.depop"].tap()
        let web = app.webViews.firstMatch
        let username = web.textFields.firstMatch
        XCTAssertTrue(username.waitForExistence(timeout: 20), "the sign-in page did not load\n\(app.debugDescription)")
        username.tap()
        username.typeText("e2e-seller")
        let password = web.secureTextFields.firstMatch
        password.tap()
        // Return submits the form: WebKit zooms into a focused field, which can leave the button
        // off screen.
        password.typeText("not-for-listora\n")
        XCTAssertTrue(
            web.staticTexts["Selling hub"].waitForExistence(timeout: 30),
            "the fake Depop did not sign in\n\(app.debugDescription)",
        )
        try await before()
        app.buttons["signIn.done"].tap()
        if waitForLinked {
            await self.waitForLinked()
        }
    }

    private func waitForLinked() async {
        let status = element("linkAccounts.status.depop")
        let linked = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "Linked"), object: status)
        await fulfillment(of: [linked], timeout: 90)
    }

    /// Polls `condition` every second until it holds.
    private func waitFor(
        _ what: String,
        timeout: TimeInterval = 30,
        _ condition: () async throws -> Bool,
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if try await condition() {
                return
            }
            try await Task.sleep(for: .seconds(1))
        }
        XCTFail("timed out waiting for \(what)")
    }
}
