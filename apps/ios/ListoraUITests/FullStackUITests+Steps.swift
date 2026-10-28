import XCTest

/// The steps `FullStackUITests` shares.
extension FullStackUITests {
    /// The full stack with no fault left by an earlier test, and Poshmark and Mercari unlinked,
    /// so nothing waits for a phone an earlier test linked them on (each test starts with fresh
    /// local data, so this phone holds no session).
    func prepared() async throws -> FullStack {
        let full = try FullStack.fromEnvironment()
        try await full.clearAllFaults()
        for marketplace in ["poshmark", "mercari"] {
            try await full.stack.unlink(marketplace)
        }
        return full
    }

    /// Opens the app signed in with a dev session, on fresh local data.
    func launch(token: String, email: String, full: FullStack, fixturePhotos: Bool = false) throws {
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": full.stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": token,
            "LISTORA_DEV_ACCESS_EMAIL": email,
        ]
        if fixturePhotos {
            app.launchEnvironment["LISTORA_FIXTURE_PHOTOS"] = try fixturesPath()
        }
        app.launch()
        skipGettingStartedIfShown()
        XCTAssertTrue(app.tabRail.buttons["Inventory"].waitForExistence(timeout: 15))
    }

    /// From a signed-out launch: the welcome screen, the seller's email, and the code the dev
    /// sign-in printed (what their email would show), then the tabs.
    func signIn(_ full: FullStack) async throws {
        app.launchEnvironment = try [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": full.stack.apiURL.absoluteString,
            "LISTORA_FIXTURE_PHOTOS": fixturesPath(),
        ]
        app.launch()
        XCTAssertTrue(element("signIn.welcome").waitForExistence(timeout: 15), "no welcome screen")
        XCTAssertFalse(app.tabRail.exists, "the tabs show only once signed in")
        let email = app.textFields["signIn.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 5))
        email.tap()
        email.typeText(full.stack.email)
        app.buttons["signIn.continue"].tap()
        let code = app.textFields["signIn.code"]
        XCTAssertTrue(code.waitForExistence(timeout: 15), "no code screen")
        keepScreenshot("Enter the code")
        try await code.typeText(full.signInCode(for: full.stack.email))
        app.buttons["signIn.signIn"].tap()
        skipGettingStartedIfShown()
        XCTAssertTrue(app.tabRail.buttons["Today"].waitForExistence(timeout: 15), "signing in shows the tabs")
        keepScreenshot("Signed in")
    }

    /// The first sign-in shows the getting-started guide over the app.
    func skipGettingStartedIfShown() {
        let skip = app.buttons["gettingStarted.skip"]
        if skip.waitForExistence(timeout: 5) {
            skip.tap()
        }
    }

    /// Settings opens from the avatar on Today.
    func openSettings() {
        app.tabRail.buttons["Today"].tap()
        let settings = app.buttons["settings.open"]
        XCTAssertTrue(settings.waitForExistence(timeout: 15), "no Settings\n\(app.debugDescription)")
        settings.tap()
    }

    /// Settings > Link accounts: signs in on each marketplace's fake site in the app's own web
    /// view, and waits until this iPhone's session check says Linked; then closes Settings.
    func linkOnThisPhone(_: FullStack, _ marketplaces: [String]) async throws {
        openSettings()
        let linkAccounts = app.buttons["settings.linkAccounts"]
        XCTAssertTrue(linkAccounts.waitForExistence(timeout: 15), "no Link accounts\n\(app.debugDescription)")
        linkAccounts.tap()
        for marketplace in marketplaces {
            let status = element("linkAccounts.status.\(marketplace)")
            XCTAssertTrue(status.waitForExistence(timeout: 20), "no \(marketplace) row")
            app.buttons["linkAccounts.link.\(marketplace)"].tap()
            // Mercari signs in with an email; Poshmark with a username, which has no "@".
            signInOnFakeSite(username: marketplace == "mercari" ? "e2e-seller@listora.test" : "e2e_seller")
            XCTAssertTrue(
                waitForLabel(of: status, "Linked", timeout: 120),
                "\(marketplace): \(status.label) \(element("linkAccounts.detail.\(marketplace)").label)",
            )
            XCTAssertTrue(element("linkAccounts.runsOn.\(marketplace)").label.hasPrefix("Runs on this iPhone"))
        }
        keepScreenshot("Linked on this iPhone")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["settings.done"].tap()
    }

    /// Signs in on the fake marketplace's sign-in page in the app's web view (any name and
    /// password do), then hands the session to Listora.
    func signInOnFakeSite(username: String) {
        let web = app.webViews.firstMatch
        let name = web.textFields.firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 20), "the sign-in page did not load\n\(app.debugDescription)")
        name.tap()
        name.typeText(username)
        let password = web.secureTextFields.firstMatch
        password.tap()
        // Return submits the form: WebKit zooms into a focused field, which can leave the button
        // off screen.
        password.typeText("not-for-listora\n")
        XCTAssertTrue(password.waitForNonExistence(timeout: 30), "the fake site did not sign in")
        app.buttons["signIn.done"].tap()
    }

    /// Imports the fixture photos, waits for the AI draft, and saves it at the recommended price
    /// with its cost. Returns the new item's SKU.
    func createItemFromPhotos() -> String {
        app.tabRail.buttons["Add"].tap()
        let importPhotos = app.buttons["addItem.importPhotos"]
        XCTAssertTrue(importPhotos.waitForExistence(timeout: 10))
        importPhotos.tap()
        XCTAssertTrue(app.buttons["photo.tile.2"].waitForExistence(timeout: 30), "the photos did not import")
        let review = app.buttons["draft.review"]
        XCTAssertTrue(review.waitForExistence(timeout: 5))
        review.tap()

        // The upload, the photo processing, and the fake AI's analysis.
        let proceed = app.buttons["review.continue"]
        XCTAssertTrue(proceed.waitForExistence(timeout: 120), "the review never appeared")
        let brand = app.buttons["review.field.brand"]
        XCTAssertTrue(waitForLabel(of: brand, "Brand, Levi's, From AI", timeout: 10, contains: true), brand.label)
        keepScreenshot("Review")
        proceed.tap()

        let amount = app.staticTexts["cost.amount"]
        XCTAssertTrue(amount.waitForExistence(timeout: 10))
        app.buttons["keypad.8"].tap()
        XCTAssertEqual(amount.value as? String, "$8")
        app.buttons["cost.continue"].tap()

        let recommended = app.buttons["price.tier.recommended"]
        XCTAssertTrue(recommended.waitForExistence(timeout: 15))
        XCTAssertTrue(recommended.label.contains("$30.00"), recommended.label)
        recommended.tap()
        app.buttons["price.save"].tap()
        let saved = app.staticTexts["saved.sku"]
        XCTAssertTrue(saved.waitForExistence(timeout: 15))
        keepScreenshot("Saved")
        let sku = saved.label.replacingOccurrences(of: "SKU ", with: "")
        app.buttons["saved.done"].tap()
        return sku
    }

    func openItem(sku: String) {
        app.tabRail.buttons["Inventory"].tap()
        let row = app.buttons["inventory.row.\(sku)"]
        XCTAssertTrue(row.waitForExistence(timeout: 20), "\(sku) is not in the inventory")
        row.tap()
        XCTAssertTrue(status("ebay").waitForExistence(timeout: 15), "the item screen did not open")
    }

    /// List on eBay, with the other three switched on too: each marketplace's version is
    /// reviewed and sent in turn.
    func listEverywhere() {
        XCTAssertTrue(waitForLabel(of: status("ebay"), "Not listed", timeout: 15), statusLabel("ebay"))
        app.buttons["marketplace.ebay.action.list"].tap()
        let next = app.buttons["listing.next"]
        XCTAssertTrue(next.waitForExistence(timeout: 10))
        for marketplace in Self.marketplaces where marketplace != "ebay" {
            let choice = app.switches["listing.choose.\(marketplace)"]
            XCTAssertTrue(choice.waitForExistence(timeout: 10))
            XCTAssertTrue(choice.isEnabled, "\(marketplace) is not offered: \(choice.label)")
            if choice.value as? String != "1" {
                choice.swipeUpIfHidden(in: app)
                // The switch sits at the card's trailing edge.
                choice.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
            }
            XCTAssertTrue(waitForValue(of: choice, "1"), "\(marketplace) is not chosen")
        }
        XCTAssertEqual(next.label, "Review 4 listings")
        keepScreenshot("Choose marketplaces")
        next.tap()

        let publish = app.buttons["listing.publish"]
        for marketplace in Self.marketplaces {
            let title = "Publish to \(name(marketplace))"
            XCTAssertTrue(waitForLabel(of: publish, title, timeout: 15), "\(title): \(publish.label)")
            XCTAssertFalse((app.textFields["listing.title"].value as? String ?? "").isEmpty)
            publish.tap()
        }
        XCTAssertTrue(waitForAbsence(of: publish, timeout: 15), "the listing sheet did not close")
    }

    /// Every marketplace's listing reads "Active (confirmed by ...)": eBay and Depop from their
    /// APIs, Poshmark and Mercari once this iPhone has run them.
    func waitForActiveEverywhere() {
        for marketplace in Self.marketplaces {
            let label = "Active (confirmed by \(name(marketplace)))"
            XCTAssertTrue(
                waitForLabel(of: scrolledTo(status(marketplace)), label, timeout: 240),
                "\(marketplace): \(statusLabel(marketplace))",
            )
        }
    }

    /// Opens the item from the inventory again until `done` holds: the item screen reads the
    /// server when it opens, as when the seller comes back to it after a sale.
    func reopenUntil(sku: String, timeout: TimeInterval, _ done: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if status("ebay").waitForExistence(timeout: 2), done() {
                return true
            }
            sleep(3)
            if done() {
                return true
            }
            app.navigationBars.buttons.element(boundBy: 0).tap()
            openItem(sku: sku)
        }
        return done()
    }

    func status(_ marketplace: String) -> XCUIElement {
        element("marketplace.\(marketplace).status")
    }

    /// The marketplace's status on the item screen, scrolled into view first (rows below the
    /// fold may not be built yet).
    func statusLabel(_ marketplace: String) -> String {
        scrolledTo(status(marketplace)).label
    }

    func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    /// `element` once it is on screen: swipes up, then back down, a few times at most.
    @discardableResult
    func scrolledTo(_ element: XCUIElement) -> XCUIElement {
        for direction in [true, false] {
            for _ in 0 ..< 4 where !(element.exists && element.isHittable) {
                if direction {
                    app.swipeUp()
                } else {
                    app.swipeDown()
                }
            }
        }
        return element
    }

    func name(_ marketplace: String) -> String {
        Self.names[marketplace] ?? marketplace
    }

    func statuses() -> String {
        Self.marketplaces.map { "\($0): \(element("marketplace.\($0).status").label)" }.joined(separator: ", ")
            + ", run: \(element("item.delistRun").label)"
    }

    func fixturesPath() throws -> String {
        try XCTUnwrap(Bundle(for: Self.self).url(forResource: "Fixtures", withExtension: nil))
            .path(percentEncoded: false)
    }

    /// Keeps a screenshot in the result bundle, passing or not, for reviewing the screens.
    func keepScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func waitForLabel(
        of element: XCUIElement,
        _ label: String,
        timeout: TimeInterval,
        contains: Bool = false,
    ) -> Bool {
        let predicate = NSPredicate(format: contains ? "label CONTAINS %@" : "label == %@", label)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }

    func waitForValue(of element: XCUIElement, _ value: String, timeout: TimeInterval = 5) -> Bool {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", value),
            object: element,
        )
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }

    func waitForEnabled(_ element: XCUIElement, timeout: TimeInterval = 10) -> Bool {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"),
            object: element,
        )
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }

    func waitForAbsence(of element: XCUIElement, timeout: TimeInterval = 10) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }
}
