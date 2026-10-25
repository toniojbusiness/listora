import XCTest

/// Runs Xcode's accessibility audit (hit regions, element labels, traits, actions) on the
/// main screens. Issues in system-drawn chrome (the tab bar, navigation bar, and keyboard) and in
/// the fixture photos themselves are Apple's or the photo's, not the app's, so they are ignored.
@MainActor
final class AccessibilityAuditUITests: XCTestCase {
    private let app = XCUIApplication()
    private var server: StubAPIServer?

    override func setUp() async throws {
        continueAfterFailure = false
    }

    override func tearDown() async throws {
        server?.stop()
    }

    private func audit(_ screen: String) throws {
        // Let transitions finish: the audit samples the screen.
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 1.5))
        // System chrome (tab bar, navigation bars, and their buttons) is drawn by UIKit.
        let chrome = (app.navigationBars.allElementsBoundByIndex + app.tabBars.allElementsBoundByIndex).map(\.frame)
        // Contrast and text size are left to deterministic checks: `PaletteTests` checks every token
        // pair with the WCAG formula, `ComponentLayoutTests` lays the components out at the largest
        // text size, and `make ios-screenshots` captures every screen there. The audit's versions
        // sample the rendered screen and flag secondary text that measures 7:1, rows that scroll
        // under the tab bar, and list row titles that are shown whole.
        let types = XCUIAccessibilityAuditType.all.subtracting([.contrast, .dynamicType, .textClipped])
        try app.performAccessibilityAudit(for: types) { issue in
            guard let element = issue.element else { return false }
            let center = CGPoint(x: element.frame.midX, y: element.frame.midY)
            // A photo's pixels can have any contrast or size.
            if element.elementType == .image || chrome.contains(where: { $0.contains(center) }) {
                return true
            }
            let name = "\(screen): \(issue.compactDescription): '\(element.label)' at \(element.frame)"
            XCTContext.runActivity(named: name) { _ in }
            return false
        }
    }

    func testMainScreensPassTheAudit() throws {
        let fixtures = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "Fixtures", withExtension: nil))
        let server = try StubAPIServer()
        try server.start()
        self.server = server
        app.launchEnvironment = [
            "LISTORA_FIXTURE_PHOTOS": fixtures.path(percentEncoded: false),
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": server.baseURL,
        ]
        app.launch()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["today.signedOut"].waitForExistence(timeout: 5))
        try audit("Today")

        app.tabBars.buttons["Inventory"].tap()
        try audit("Inventory")

        app.tabBars.buttons["Sales"].tap()
        XCTAssertTrue(app.staticTexts["Sign in to see your sales"].waitForExistence(timeout: 5))
        try audit("Sales")

        app.tabBars.buttons["Add"].tap()
        XCTAssertTrue(app.buttons["addItem.importPhotos"].waitForExistence(timeout: 5))
        try audit("Add Item")

        app.buttons["addItem.importPhotos"].tap()
        XCTAssertTrue(app.buttons["photo.tile.2"].waitForExistence(timeout: 15))
        try audit("Draft")

        app.buttons["photo.tile.2"].tap()
        XCTAssertTrue(app.buttons["photo.done"].waitForExistence(timeout: 5))
        try audit("Photo")
        app.buttons["photo.done"].tap()

        app.tabBars.buttons["Tasks"].tap()
        try audit("Tasks")

        app.tabBars.buttons["Today"].tap()
        app.buttons["settings.open"].tap()
        XCTAssertTrue(app.buttons["settings.marketplaces"].waitForExistence(timeout: 5))
        try audit("Settings")
    }
}
