import XCTest

/// "What sells for you" (docs/features/thrift-scan.md, "Sourcing insights") against the local
/// stack (`make ios-test`, packages/e2e): it opens from Scan mode and from the start of a run.
/// The stack's account may have sold nothing yet, so the screen shows either its insights or the
/// empty state, never the no-signal one.
@MainActor
final class SourcingInsightsUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testWhatSellsForYouOpensFromScanModeAndTheStartOfARun() throws {
        let stack = try E2EStack.fromEnvironment()
        let fixtures = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "Fixtures", withExtension: nil))
        app.launchEnvironment = [
            // Scan mode starts a run only with a camera: the debug fake one.
            "LISTORA_FAKE_CAMERA": fixtures.path(percentEncoded: false),
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": stack.token,
            "LISTORA_DEV_ACCESS_EMAIL": stack.email,
            "LISTORA_RESET_LOCAL_DATA": "1",
        ]
        app.launchQuietly()
        let tab = app.tabRail.buttons["Add"]
        XCTAssertTrue(tab.waitForExistence(timeout: 10))
        tab.tap()
        let scanMode = app.segmentedControls["addItem.mode"].buttons["Scan"]
        XCTAssertTrue(scanMode.waitForExistence(timeout: 15), "Scan mode shows where the thrift scan is on")
        scanMode.tap()
        let link = app.buttons["addItem.sourcingInsights"]
        XCTAssertTrue(link.waitForExistence(timeout: 5))
        link.tap()
        expectInsightsScreen()
        attachScreenshot("what sells for you")
        app.navigationBars.buttons.firstMatch.tap()

        app.buttons["addItem.startScan"].tap()
        let fromStart = app.buttons["scanStart.insights"]
        XCTAssertTrue(fromStart.waitForExistence(timeout: 5))
        attachScreenshot("start a run with what to look for")
        fromStart.tap()
        expectInsightsScreen()
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.buttons["scanStart.start"].waitForExistence(timeout: 5))
    }

    private func expectInsightsScreen() {
        XCTAssertTrue(app.navigationBars["What sells for you"].waitForExistence(timeout: 10))
        let shown = element("insights.empty").waitForExistence(timeout: 10) || element("insights.basedOn").exists
        XCTAssertTrue(shown, "the screen shows the insights or says there are not enough sales yet")
        XCTAssertFalse(element("insights.unavailable").exists, "the kit loads with signal")
    }

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    private func attachScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
