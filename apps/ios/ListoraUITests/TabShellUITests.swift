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

    func testShowsTheFourTabsAndOpensInventory() {
        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(tabBar.waitForExistence(timeout: 10))
        for title in ["Inventory", "Add Item", "Tasks", "Settings"] {
            XCTAssertTrue(tabBar.buttons[title].exists, "missing tab \(title)")
        }
        XCTAssertTrue(app.navigationBars["Inventory"].exists)
        XCTAssertTrue(app.staticTexts["Sign in to see your inventory"].waitForExistence(timeout: 5))
    }

    func testEachTabShowsItsScreen() {
        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(tabBar.waitForExistence(timeout: 10))
        let expected: [(tab: String, text: String)] = [
            ("Add Item", "Take photos once"),
            ("Tasks", "You're all caught up"),
            ("Settings", "Environment"),
            ("Inventory", "Sign in to see your inventory"),
        ]
        for (tab, text) in expected {
            tabBar.buttons[tab].tap()
            XCTAssertTrue(app.navigationBars[tab].waitForExistence(timeout: 5), "no \(tab) screen")
            XCTAssertTrue(app.staticTexts[text].exists, "\(tab) does not show \(text)")
        }
    }

    func testAddItemFromTheSignedOutInventorySwitchesTabs() {
        let addItem = app.buttons["Add item"]
        XCTAssertTrue(addItem.waitForExistence(timeout: 10))
        addItem.tap()
        XCTAssertTrue(app.navigationBars["Add Item"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.tabBars.buttons["Add Item"].isSelected)
    }

    func testSettingsShowsTheDevEnvironmentAndLocalAPI() {
        let settings = app.tabBars.buttons["Settings"]
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
    }

    func testSettingsOpensTheMarketplacesScreen() {
        let settings = app.tabBars.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.tap()
        let marketplaces = app.buttons["settings.marketplaces"]
        XCTAssertTrue(marketplaces.waitForExistence(timeout: 5))
        marketplaces.tap()
        XCTAssertTrue(app.navigationBars["Marketplaces"].waitForExistence(timeout: 5))
    }
}
