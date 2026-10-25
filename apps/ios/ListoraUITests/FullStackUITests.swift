import XCTest

/// The full-stack end-to-end suite (plan task T-27): the app against everything the backend has,
/// on fakes only. `make e2e-full` starts the full local stack (packages/e2e, `--marketplaces all`):
/// the API and the worker, the fake eBay (with its notifications), the fake Depop API, the fake
/// Poshmark, Mercari, and Depop sites driven by the browser runner, and the fake AI. The seller
/// has eBay and Depop connected through their APIs and Poshmark and Mercari linked for
/// automation; a second seller's Depop is automated. Every status the suite waits for is the
/// server's own label, which says "confirmed by" only after the marketplace was read back.
///
/// Under `make ios-test` (the eBay-only stack) these tests skip.
@MainActor
final class FullStackUITests: XCTestCase {
    let app = XCUIApplication()

    /// Every marketplace, in the order the app lists them.
    static let marketplaces = ["ebay", "depop", "poshmark", "mercari"]
    static let names = ["ebay": "eBay", "depop": "Depop", "poshmark": "Poshmark", "mercari": "Mercari"]
    /// A seeded item every marketplace takes (Depop's API maps t-shirts).
    static let tee: [String: String] = [
        "title": "Levi's Graphic Tee",
        "description": "Blue Levi's graphic tee in soft cotton, size M. Light fading on the print.",
        "category": "clothing/tops/t_shirts",
    ]

    override func setUp() async throws {
        continueAfterFailure = false
    }

    /// Scenarios 1 and 2: photos to an AI draft, review, price, and save; listed on eBay and Depop
    /// through their APIs and on Poshmark and Mercari by automation, each confirmed by read-back.
    /// Then it sells on eBay: eBay's notification records the sale, auto-delist takes it down
    /// everywhere else, and the item screen shows what each marketplace confirmed.
    func testPhotosToListedEverywhereThenAnEbaySaleDelistsTheRest() async throws {
        let stack = try await prepared()
        try launch(token: stack.token, email: stack.email, stack: stack, fixturePhotos: true)

        let sku = createItemFromPhotos()
        openItem(sku: sku)
        listEverywhere()
        for marketplace in Self.marketplaces {
            XCTAssertTrue(
                waitForLabel(of: status(marketplace), "Active (confirmed by \(name(marketplace)))", timeout: 180),
                "\(marketplace): \(status(marketplace).label)",
            )
        }
        keepScreenshot("Listed everywhere")

        try await stack.sellOnEbay(sku: sku)
        // The seller opens the item again (as from the sale's notification).
        let truth = [
            "ebay": "Sold (confirmed by eBay)",
            "depop": "Marked sold (confirmed by Depop)",
            "poshmark": "Delisted (confirmed by Poshmark)",
            "mercari": "Delisted (confirmed by Mercari)",
        ]
        XCTAssertTrue(reopenUntil(sku: sku, timeout: 180) {
            truth.allSatisfy { self.status($0.key).label == $0.value }
                && self.element("item.delistRun").label == "Delisted everywhere"
        }, statuses())
        XCTAssertTrue(app.buttons["item.sale"].label.contains("On eBay"), app.buttons["item.sale"].label)
        keepScreenshot("Sold on eBay, delisted everywhere")
    }

    /// Scenario 3: the delist after a sale fails on one marketplace (Poshmark refuses the change):
    /// the item screen says so with Retry, the other marketplaces are delisted, and Retry works.
    func testADelistThatFailsOnOneMarketplaceShowsRetryAndTheRetryDelistsIt() async throws {
        let stack = try await prepared()
        let item = try await stack.seedListedItem(on: Self.marketplaces, details: Self.tee)
        try await stack.injectAutomationFault(
            marketplace: "poshmark",
            action: "update",
            type: "reject",
            message: "This listing can't be changed right now.",
        )
        try launch(token: stack.token, email: stack.email, stack: stack)
        openItem(sku: item.sku)
        XCTAssertTrue(waitForLabel(of: status("poshmark"), "Active (confirmed by Poshmark)", timeout: 15))

        try await stack.sellOnEbay(sku: item.sku)
        XCTAssertTrue(reopenUntil(sku: item.sku, timeout: 180) {
            self.status("poshmark").label == "Delist failed - Retry"
                && self.status("mercari").label == "Delisted (confirmed by Mercari)"
                && self.status("depop").label == "Marked sold (confirmed by Depop)"
        }, statuses())
        XCTAssertEqual(element("item.delistRun").label, "Delist failed on Poshmark - Retry")
        XCTAssertTrue(
            element("marketplace.poshmark.detail").label.contains("can't be changed right now"),
            element("marketplace.poshmark.detail").label,
        )
        keepScreenshot("Delist failed on Poshmark")

        let retry = app.buttons["marketplace.poshmark.action.retry"]
        retry.swipeUpIfHidden(in: app)
        retry.tap()
        XCTAssertTrue(
            waitForLabel(of: status("poshmark"), "Delisted (confirmed by Poshmark)", timeout: 120),
            status("poshmark").label,
        )
        XCTAssertTrue(waitForLabel(of: element("item.delistRun"), "Delisted everywhere", timeout: 30))
        keepScreenshot("Retry delisted it")
    }

    /// Scenarios 4 and 6: Depop shows a CAPTCHA while automation lists the second seller's item.
    /// Listora never solves one: the step stops and becomes a task in the Tasks tab, and the Depop
    /// connection needs relinking, which the banner and the Marketplaces screen say.
    func testACaptchaStopsAutomationForATaskAndTheConnectionNeedsRelinking() async throws {
        let stack = try await prepared()
        let second = try XCTUnwrap(stack.secondSeller)
        // A fresh session before and after, so a rerun starts with Depop automated.
        try await stack.linkSession("depop")
        addTeardownBlock { try await stack.linkSession("depop") }
        let item = try await stack.seedReadyItem(seller: "second", details: Self.tee)
        try await stack.injectAutomationFault(marketplace: "depop", action: "form", type: "captcha")
        try launch(token: second.token, email: second.email, stack: stack)

        openItem(sku: item.sku)
        let list = app.buttons["marketplace.depop.action.list"]
        list.swipeUpIfHidden(in: app)
        list.tap()
        let next = app.buttons["listing.next"]
        XCTAssertTrue(next.waitForExistence(timeout: 10))
        XCTAssertTrue(waitForEnabled(next), "Depop is not offered")
        XCTAssertTrue(
            app.switches["listing.choose.depop"].label.contains("Automated in your Depop session"),
            app.switches["listing.choose.depop"].label,
        )
        next.tap()
        let publish = app.buttons["listing.publish"]
        XCTAssertTrue(publish.waitForExistence(timeout: 5))
        XCTAssertEqual(publish.label, "Publish to Depop")
        publish.tap()

        // The runner met the CAPTCHA and stopped: the listing waits for the seller instead.
        XCTAssertTrue(
            waitForLabel(of: status("depop"), "Action needed - list on Depop", timeout: 120),
            status("depop").label,
        )
        XCTAssertFalse(status("depop").label.contains("confirmed"))
        keepScreenshot("CAPTCHA: action needed")

        app.tabBars.buttons["Tasks"].tap()
        let task = app.buttons["tasks.row.list_manually.depop.\(item.sku)"]
        XCTAssertTrue(task.waitForExistence(timeout: 15), "the list task is not in the inbox")
        XCTAssertTrue(app.buttons["tasks.row.reconnect.depop.none"].exists, "no reconnect task")
        keepScreenshot("Tasks: list by hand, reconnect")

        // The health screen: Depop needs relinking, in the server's words. The banner is on the
        // inventory list, under the item screen the Inventory tab still shows.
        app.tabBars.buttons["Inventory"].tap()
        if status("depop").waitForExistence(timeout: 3) {
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
        let banner = element("connectionAttention.banner")
        XCTAssertTrue(banner.waitForExistence(timeout: 15), "no connection banner")
        XCTAssertTrue(banner.label.contains("Reconnect Depop"), banner.label)
        app.buttons["connectionAttention.open"].tap()
        XCTAssertTrue(app.navigationBars["Marketplaces"].waitForExistence(timeout: 5))
        let depop = element("marketplaces.depop.status")
        XCTAssertTrue(waitForLabel(of: depop, "Reconnect needed", timeout: 10), depop.label)
        XCTAssertTrue(element("marketplaces.depop.detail").label.contains("CAPTCHA"))
        XCTAssertEqual(element("marketplaces.depop.mode").label, "Automation mode")
        keepScreenshot("Marketplaces: Depop needs relinking")
    }

    /// Scenario 5: the seller marks the item sold on Mercari from the item screen; Listora takes
    /// it down everywhere else and shows each marketplace's confirmation.
    func testMarkSoldFromTheItemScreenDelistsEverywhereElse() async throws {
        let stack = try await prepared()
        let item = try await stack.seedListedItem(on: Self.marketplaces, details: Self.tee)
        try launch(token: stack.token, email: stack.email, stack: stack)
        openItem(sku: item.sku)
        XCTAssertTrue(waitForLabel(of: status("mercari"), "Active (confirmed by Mercari)", timeout: 15))

        let markSold = app.buttons["item.markSold"]
        markSold.swipeUpIfHidden(in: app)
        markSold.tap()
        let mercari = app.buttons["markSold.marketplace.mercari"]
        XCTAssertTrue(mercari.waitForExistence(timeout: 5))
        mercari.tap()
        let save = app.buttons["markSold.save"]
        XCTAssertTrue(waitForEnabled(save), app.staticTexts["markSold.hint"].label)
        save.tap()

        let soldOn = app.staticTexts["sale.soldOn"]
        XCTAssertTrue(soldOn.waitForExistence(timeout: 15))
        XCTAssertTrue(soldOn.label.hasPrefix("Sold on Mercari"), soldOn.label)
        let delists = [
            "ebay": "Delisted (confirmed by eBay)",
            "depop": "Marked sold (confirmed by Depop)",
            "poshmark": "Delisted (confirmed by Poshmark)",
        ]
        for (marketplace, label) in delists {
            let delist = element("sale.delist.\(marketplace)")
            XCTAssertTrue(waitForLabel(of: delist, label, timeout: 120), "\(marketplace): \(delist.label)")
        }
        XCTAssertFalse(element("sale.delist.mercari").exists, "the marketplace it sold on is not delisted")
        keepScreenshot("Marked sold on Mercari")
    }
}

// MARK: Steps

extension FullStackUITests {
    /// The full stack with no fault left by an earlier test.
    func prepared() async throws -> E2EStack {
        let stack = try E2EStack.fullFromEnvironment()
        try await stack.clearAllFaults()
        return stack
    }

    func launch(token: String, email: String, stack: E2EStack, fixturePhotos: Bool = false) throws {
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": token,
            "LISTORA_DEV_ACCESS_EMAIL": email,
        ]
        if fixturePhotos {
            let fixtures = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "Fixtures", withExtension: nil))
            app.launchEnvironment["LISTORA_FIXTURE_PHOTOS"] = fixtures.path(percentEncoded: false)
        }
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Inventory"].waitForExistence(timeout: 10))
    }

    /// Imports the fixture photos, waits for the AI draft, and saves it at the recommended price
    /// with its cost. Returns the new item's SKU.
    func createItemFromPhotos() -> String {
        app.tabBars.buttons["Add Item"].tap()
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
        app.tabBars.buttons["Inventory"].tap()
        let row = app.buttons["inventory.row.\(sku)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "\(sku) is not in the inventory")
        row.tap()
        XCTAssertTrue(status("ebay").waitForExistence(timeout: 15), "the item screen did not open")
    }

    /// List on eBay, with the other three switched on too: each marketplace's version is
    /// reviewed and sent in turn.
    func listEverywhere() {
        XCTAssertTrue(waitForLabel(of: status("ebay"), "Not listed", timeout: 15), status("ebay").label)
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

    func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier]
    }

    func name(_ marketplace: String) -> String {
        Self.names[marketplace] ?? marketplace
    }

    func statuses() -> String {
        Self.marketplaces.map { "\($0): \(status($0).label)" }.joined(separator: ", ")
            + ", run: \(element("item.delistRun").label)"
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
