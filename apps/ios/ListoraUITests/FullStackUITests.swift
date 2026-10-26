import XCTest

/// The full-stack end-to-end suite (plan task T-27, docs/features/e2e.md): the app against
/// everything the backend has, on fakes only. `make e2e-full` starts the full local stack
/// (packages/e2e, `--marketplaces all`): the API and the worker, the fake eBay (with its
/// notifications), the fake Depop API, the fake Poshmark and Mercari sites (which the app's phone
/// runtime acts on, as Poshmark and Mercari run on the seller's iPhone), the fake eBay site (the
/// second seller's eBay, automated in the cloud by the browser runner), and the fake AI. Every
/// status the suite waits for is the server's own label, which says "confirmed by" only after the
/// marketplace was read back.
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

    /// Scenarios 1 and 2, from a signed-out phone: sign in with the emailed code, link Poshmark
    /// and Mercari on this iPhone, then photos to an AI draft, review, price, and save; listed on
    /// eBay and Depop through their APIs and on Poshmark and Mercari from this iPhone, each
    /// confirmed by read-back. Then it sells on eBay: eBay's notification records the sale,
    /// auto-delist takes it down everywhere else, and the item screen shows what each
    /// marketplace confirmed.
    func testSignInPhotosToListedEverywhereThenAnEbaySaleDelistsTheRest() async throws {
        let full = try await prepared()
        try await signIn(full)
        try await linkOnThisPhone(full, ["poshmark", "mercari"])

        let sku = createItemFromPhotos()
        openItem(sku: sku)
        listEverywhere()
        waitForActiveEverywhere()
        keepScreenshot("Listed everywhere")

        try await full.sellOnEbay(sku: sku)
        // The seller opens the item again (as from the sale's notification).
        let truth = [
            "ebay": "Sold (confirmed by eBay)",
            "depop": "Marked sold (confirmed by Depop)",
            "poshmark": "Delisted (confirmed by Poshmark)",
            "mercari": "Delisted (confirmed by Mercari)",
        ]
        XCTAssertTrue(reopenUntil(sku: sku, timeout: 240) {
            truth.allSatisfy { self.statusLabel($0.key) == $0.value }
                && self.element("item.delistRun").label == "Delisted everywhere"
        }, statuses())
        XCTAssertTrue(element("item.sale").label.contains("On eBay"), element("item.sale").label)
        keepScreenshot("Sold on eBay, delisted everywhere")
    }

    /// Scenario 3: the delist after a sale fails on one marketplace (Poshmark refuses the change
    /// this iPhone sends): the item screen says so with Retry, the others are delisted, and Retry
    /// works.
    func testADelistThatFailsOnOneMarketplaceShowsRetryAndTheRetryDelistsIt() async throws {
        let full = try await prepared()
        try launch(token: full.stack.token, email: full.stack.email, full: full)
        try await linkOnThisPhone(full, ["poshmark", "mercari"])
        let item = try await full.seedListedItem(on: Self.marketplaces, details: Self.tee)
        openItem(sku: item.sku)
        waitForActiveEverywhere()

        try await full.injectSiteFault(
            marketplace: "poshmark",
            action: "update",
            type: "reject",
            message: "This listing can't be changed right now.",
        )
        try await full.sellOnEbay(sku: item.sku)
        XCTAssertTrue(reopenUntil(sku: item.sku, timeout: 240) {
            self.statusLabel("poshmark") == "Delist failed - Retry"
                && self.statusLabel("mercari") == "Delisted (confirmed by Mercari)"
                && self.statusLabel("depop") == "Marked sold (confirmed by Depop)"
        }, statuses())
        XCTAssertEqual(element("item.delistRun").label, "Delist failed on Poshmark - Retry")
        let detail = scrolledTo(element("marketplace.poshmark.detail"))
        XCTAssertTrue(detail.label.contains("can't be changed right now"), detail.label)
        keepScreenshot("Delist failed on Poshmark")

        scrolledTo(app.buttons["marketplace.poshmark.action.retry"]).tap()
        XCTAssertTrue(
            waitForLabel(of: scrolledTo(status("poshmark")), "Delisted (confirmed by Poshmark)", timeout: 120),
            statusLabel("poshmark"),
        )
        XCTAssertTrue(waitForLabel(of: element("item.delistRun"), "Delisted everywhere", timeout: 30))
        keepScreenshot("Retry delisted it")
    }

    /// Scenario 4 on this iPhone: Mercari shows a CAPTCHA while the phone lists an item. Listora
    /// never solves one: the app hands the page to the seller; "Not now" stops the step without
    /// claiming anything, and it goes live once Mercari stops asking.
    func testACheckOnThisIPhoneIsHandedToTheSellerAndNeverPassedForThem() async throws {
        let full = try await prepared()
        try launch(token: full.stack.token, email: full.stack.email, full: full)
        try await linkOnThisPhone(full, ["mercari"])
        try await full.injectSiteFault(marketplace: "mercari", action: "form", type: "captcha")
        let item = try await full.seedListedItem(on: ["mercari"], details: Self.tee)

        let banner = element("handOff.banner")
        XCTAssertTrue(banner.waitForExistence(timeout: 90), "no hand-off\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts["Mercari wants to check it's you"].exists)
        keepScreenshot("Mercari's check handed to the seller")
        app.buttons["handOff.notNow"].tap()
        XCTAssertTrue(waitForAbsence(of: banner, timeout: 10))

        openItem(sku: item.sku)
        XCTAssertTrue(
            waitForLabel(of: scrolledTo(status("mercari")), "Active (confirmed by Mercari)", timeout: 180),
            statusLabel("mercari"),
        )
        keepScreenshot("Listed once Mercari stopped asking")
    }

    /// Scenarios 4 and 6 in the cloud: eBay shows a CAPTCHA while the browser runner lists the
    /// second seller's item. The step becomes a task, the connection needs relinking (the health
    /// screen and Link accounts say so), and Relink signs in again.
    func testACaptchaInTheCloudBecomesATaskAndRelinkFixesTheConnection() async throws {
        let full = try await prepared()
        // A fresh session before and after, so a rerun starts with eBay automated.
        try await full.linkSecondSellersEbay()
        addTeardownBlock { try await full.linkSecondSellersEbay() }
        let item = try await full.seedReadyItem(seller: "second", details: Self.tee)
        try await full.injectSiteFault(marketplace: "ebay", action: "form", type: "captcha")
        try launch(token: full.secondToken, email: full.secondEmail, full: full)

        openItem(sku: item.sku)
        scrolledTo(app.buttons["marketplace.ebay.action.list"]).tap()
        let next = app.buttons["listing.next"]
        XCTAssertTrue(next.waitForExistence(timeout: 10))
        XCTAssertTrue(waitForEnabled(next), "eBay is not offered")
        next.tap()
        let publish = app.buttons["listing.publish"]
        XCTAssertTrue(waitForLabel(of: publish, "Publish to eBay", timeout: 10), publish.label)
        publish.tap()

        // The runner met the CAPTCHA and stopped: the listing waits for the seller instead.
        XCTAssertTrue(
            waitForLabel(of: scrolledTo(status("ebay")), "Action needed - list on eBay", timeout: 120),
            statusLabel("ebay"),
        )
        keepScreenshot("CAPTCHA: action needed")

        app.tabBars.buttons["Tasks"].tap()
        let task = app.buttons["tasks.row.list_manually.ebay.\(item.sku)"]
        XCTAssertTrue(task.waitForExistence(timeout: 15), "the list task is not in the inbox")
        XCTAssertTrue(app.buttons["tasks.row.reconnect.ebay.none"].exists, "no reconnect task")
        keepScreenshot("Tasks: list by hand, reconnect")

        // The health screen says eBay needs relinking, in the server's words.
        openSettings()
        let marketplaces = app.buttons["settings.marketplaces"]
        XCTAssertTrue(marketplaces.waitForExistence(timeout: 10))
        marketplaces.tap()
        let health = element("marketplaces.ebay.status")
        XCTAssertTrue(waitForLabel(of: health, "Sign in again", timeout: 15), health.label)
        XCTAssertTrue(element("marketplaces.ebay.detail").label.contains("CAPTCHA"))
        keepScreenshot("Marketplaces: eBay needs relinking")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Relink: sign in on eBay again in Link accounts; the cloud's check passes.
        app.buttons["settings.linkAccounts"].tap()
        let linkStatus = element("linkAccounts.status.ebay")
        XCTAssertTrue(waitForLabel(of: linkStatus, "Sign in again", timeout: 15), linkStatus.label)
        let relink = app.buttons["linkAccounts.link.ebay"]
        XCTAssertEqual(relink.label, "Relink")
        try await full.clearAllFaults()
        relink.tap()
        signInOnFakeSite(username: "e2e-second-seller")
        XCTAssertTrue(waitForLabel(of: linkStatus, "Linked", timeout: 120), linkStatus.label)
        keepScreenshot("Relinked")
    }

    /// Scenario 5: the seller marks the item sold on Mercari from the item screen; Listora takes
    /// it down everywhere else (Poshmark from this iPhone) and shows each confirmation.
    func testMarkSoldFromTheItemScreenDelistsEverywhereElse() async throws {
        let full = try await prepared()
        try launch(token: full.stack.token, email: full.stack.email, full: full)
        try await linkOnThisPhone(full, ["poshmark", "mercari"])
        let item = try await full.seedListedItem(on: Self.marketplaces, details: Self.tee)
        openItem(sku: item.sku)
        waitForActiveEverywhere()

        scrolledTo(app.buttons["item.markSold"]).tap()
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
            let delist = scrolledTo(element("sale.delist.\(marketplace)"))
            XCTAssertTrue(waitForLabel(of: delist, label, timeout: 180), "\(marketplace): \(delist.label)")
        }
        XCTAssertFalse(element("sale.delist.mercari").exists, "the marketplace it sold on is not delisted")
        keepScreenshot("Marked sold on Mercari")
    }
}
