import XCTest

/// Drives the real app on the simulator, signed in without a server: the tab shell and its
/// screens. Signing in and out is `SignInUITests`.
@MainActor
final class TabShellUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
        // Without drafts, whatever an earlier test left behind: Add Item shows its guide.
        app.launchEnvironment["LISTORA_RESET_LOCAL_DATA"] = "1"
        app.signInWithoutServer()
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
        // Settings is not a tab: the gear in the header opens it.
        XCTAssertFalse(tabBar.buttons["Settings"].exists)
        XCTAssertTrue(app.buttons["settings.open"].exists)
    }

    func testEachTabShowsItsScreen() {
        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(tabBar.waitForExistence(timeout: 10))
        // The Add tab's screen is titled Add Item. Without a server, the others say they could
        // not load, with Try again.
        for tab in ["Inventory", "Add", "Tasks", "Sales", "Today"] {
            tabBar.buttons[tab].tap()
            let screen = tab == "Add" ? "Add Item" : tab
            XCTAssertTrue(app.navigationBars[screen].waitForExistence(timeout: 5), "no \(screen) screen")
            XCTAssertTrue(tabBar.buttons[tab].isSelected)
        }
        XCTAssertFalse(app.staticTexts["Sign in to see your day"].exists, "signed in, nothing asks to sign in")
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
