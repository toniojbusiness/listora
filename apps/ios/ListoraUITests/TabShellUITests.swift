import XCTest

/// Drives the real app on the simulator, signed out: the tab shell and what each screen shows.
@MainActor
final class TabShellUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
        // Signed out and without drafts, whatever an earlier test left behind: Add Item shows its
        // guide and no screen talks to a server.
        app.launchEnvironment["LISTORA_RESET_LOCAL_DATA"] = "1"
        app.launch()
    }

    func testShowsTheFiveTabsAndOpensToday() {
        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(tabBar.waitForExistence(timeout: 10))
        for title in ["Today", "Inventory", "Add", "Tasks", "Sales"] {
            XCTAssertTrue(tabBar.buttons[title].exists, "missing tab \(title)")
        }
        XCTAssertTrue(tabBar.buttons["Today"].isSelected)
        XCTAssertTrue(app.navigationBars["Today"].exists)
        XCTAssertTrue(app.staticTexts["Sign in to see your day"].waitForExistence(timeout: 5))
        // Settings is not a tab: the gear in the header opens it.
        XCTAssertFalse(tabBar.buttons["Settings"].exists)
        XCTAssertTrue(app.buttons["settings.open"].exists)
    }

    func testEachTabShowsItsScreen() {
        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(tabBar.waitForExistence(timeout: 10))
        // The Add tab's screen is titled Add Item.
        let expected: [(tab: String, text: String)] = [
            ("Inventory", "Sign in to see your inventory"),
            ("Add", "Take photos once"),
            ("Tasks", "Sign in to see your tasks"),
            ("Sales", "Sign in to see your sales"),
            ("Today", "Sign in to see your day"),
        ]
        for (tab, text) in expected {
            tabBar.buttons[tab].tap()
            let screen = tab == "Add" ? "Add Item" : tab
            XCTAssertTrue(app.navigationBars[screen].waitForExistence(timeout: 5), "no \(screen) screen")
            XCTAssertTrue(app.staticTexts[text].exists, "\(tab) does not show \(text)")
        }
    }

    func testAddItemFromTheSignedOutInventorySwitchesTabs() {
        let inventory = app.tabBars.buttons["Inventory"]
        XCTAssertTrue(inventory.waitForExistence(timeout: 10))
        inventory.tap()
        let addItem = app.buttons["Add item"]
        XCTAssertTrue(addItem.waitForExistence(timeout: 10))
        addItem.tap()
        XCTAssertTrue(app.navigationBars["Add Item"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.tabBars.buttons["Add"].isSelected)
    }

    func testSettingsShowsTheDevEnvironmentAndLocalAPI() {
        let settings = app.buttons["settings.open"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.tap()
        let environment = app.staticTexts["settings.environment"]
        XCTAssertTrue(environment.waitForExistence(timeout: 5))
        XCTAssertEqual(environment.label, "Dev")
        // Local.xcconfig may change the host or port, but Dev always targets a plain-HTTP local API.
        let apiBaseURL = app.staticTexts["settings.apiBaseURL"]
        XCTAssertTrue(apiBaseURL.exists)
        let address = apiBaseURL.value as? String ?? ""
        XCTAssertTrue(address.hasPrefix("http://"), "API base URL is \(address)")

        // Done closes Settings, back to Today.
        app.buttons["settings.done"].tap()
        XCTAssertTrue(environment.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.navigationBars["Today"].exists)
    }

    func testSalesOpensSettingsToo() {
        let sales = app.tabBars.buttons["Sales"]
        XCTAssertTrue(sales.waitForExistence(timeout: 10))
        sales.tap()
        app.buttons["settings.open"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
    }

    func testSettingsOpensTheMarketplacesScreen() {
        let settings = app.buttons["settings.open"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.tap()
        let marketplaces = app.buttons["settings.marketplaces"]
        XCTAssertTrue(marketplaces.waitForExistence(timeout: 5))
        marketplaces.tap()
        XCTAssertTrue(app.navigationBars["Marketplaces"].waitForExistence(timeout: 5))
    }
}
