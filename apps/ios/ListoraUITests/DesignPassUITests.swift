import XCTest

/// The design pass's new behavior on the simulator: the first-run guide (shown once, skippable),
/// background cleanup and its undo on a draft's photo, and the inventory's photo grid and list.
@MainActor
final class DesignPassUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func bundled(_ folder: String) throws -> String {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: folder, withExtension: nil))
        return url.path(percentEncoded: false)
    }

    // MARK: First-run guide

    func testGettingStartedWalksThroughThreeStepsOnceAndOpensAdd() {
        app.launchEnvironment = ["LISTORA_RESET_LOCAL_DATA": "1", "LISTORA_SHOW_GETTING_STARTED": "1"]
        app.signInWithoutServer()
        app.launchQuietly()
        let guide = app.buttons["gettingStarted.skip"]
        XCTAssertTrue(guide.waitForExistence(timeout: 10))
        // Every control, and the page dots VoiceOver reads, is at least a 44-point tap target.
        let targets = ["gettingStarted.skip", "gettingStarted.continue", "gettingStarted.linkAccounts"]
            .map { app.buttons[$0] } + [app.descendants(matching: .any)["gettingStarted.pageDots"]]
        for target in targets {
            XCTAssertTrue(target.exists, target.debugDescription)
            XCTAssertGreaterThanOrEqual(target.frame.width, 44, "\(target.identifier): \(target.frame)")
            XCTAssertGreaterThanOrEqual(target.frame.height, 44, "\(target.identifier): \(target.frame)")
        }
        for step in 1 ... 2 {
            XCTAssertTrue(app.descendants(matching: .any)["gettingStarted.step.\(step)"].waitForExistence(timeout: 5))
            app.buttons["gettingStarted.continue"].tap()
        }
        XCTAssertTrue(app.staticTexts["See it listed"].waitForExistence(timeout: 5))
        app.buttons["gettingStarted.addItem"].tap()
        XCTAssertTrue(waitForAbsence(of: guide))
        XCTAssertTrue(app.navigationBars["Add Item"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.tabRail.buttons["Add"].isSelected)

        // Done is done: a relaunch, even signed in, does not show it again.
        app.terminate()
        app.launchEnvironment = [:]
        app.signInWithoutServer()
        app.launchQuietly()
        XCTAssertTrue(app.tabRail.waitForExistence(timeout: 10))
        XCTAssertFalse(guide.waitForExistence(timeout: 2))
    }

    func testGettingStartedCanBeSkippedOrOpenLinkAccounts() {
        app.launchEnvironment = ["LISTORA_RESET_LOCAL_DATA": "1", "LISTORA_SHOW_GETTING_STARTED": "1"]
        app.signInWithoutServer()
        app.launchQuietly()
        let guide = app.buttons["gettingStarted.skip"]
        XCTAssertTrue(guide.waitForExistence(timeout: 10))
        app.buttons["gettingStarted.linkAccounts"].tap()
        XCTAssertTrue(waitForAbsence(of: guide))
        XCTAssertTrue(app.navigationBars["Link accounts"].waitForExistence(timeout: 10))

        app.terminate()
        app.launchQuietly()
        XCTAssertTrue(guide.waitForExistence(timeout: 10))
        guide.tap()
        XCTAssertTrue(waitForAbsence(of: guide))
        XCTAssertTrue(app.tabRail.buttons["Today"].isSelected)
    }

    // MARK: Background cleanup

    func testCleansAPhotosBackgroundAndUndoesIt() throws {
        app.launchEnvironment = try [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_FIXTURE_PHOTOS": bundled("BatchFixtures"),
        ]
        app.signInWithoutServer()
        app.launchQuietly()
        let tab = app.tabRail.buttons["Add"]
        XCTAssertTrue(tab.waitForExistence(timeout: 10))
        tab.tap()
        let cover = app.buttons["photo.tile.0"]
        let importButton = app.buttons["addItem.importPhotos"]
        for _ in 0 ..< 3 where !cover.exists {
            if importButton.exists, importButton.isEnabled {
                importButton.tap()
            }
            _ = cover.waitForExistence(timeout: 30)
        }
        cover.tap()

        let clean = app.buttons["photo.cleanBackground"]
        XCTAssertTrue(clean.waitForExistence(timeout: 5))
        clean.swipeUpIfHidden(in: app)
        clean.tap()
        let undo = app.buttons["photo.undoCleanup"]
        let failure = app.descendants(matching: .any)["photo.cleanupFailure"]
        XCTAssertTrue(
            undo.waitForExistence(timeout: 30),
            "the cleanup did not finish: \(failure.exists ? failure.label : "")\n\(app.debugDescription)",
        )
        // The sheet stays on the photo, now the cleaned one.
        XCTAssertTrue(app.descendants(matching: .any)["photo.image"].label.contains("background cleaned up"))
        XCTAssertFalse(app.descendants(matching: .any)["photo.cleanupFailure"].exists)

        undo.swipeUpIfHidden(in: app)
        undo.tap()
        XCTAssertTrue(clean.waitForExistence(timeout: 30), "the undo did not finish")
        XCTAssertFalse(app.descendants(matching: .any)["photo.image"].label.contains("background cleaned up"))
        app.buttons["photo.done"].tap()
        XCTAssertTrue(cover.waitForExistence(timeout: 5))
    }

    // MARK: Inventory layouts

    func testInventoryShowsAPhotoGridOrAListAndKeepsTheChoice() async throws {
        let stack = try E2EStack.fromEnvironment()
        let item = try await stack.seedReadyItem()
        launchInventory(signedInTo: stack, reset: true)
        let cell = app.buttons["inventory.row.\(item.sku)"]
        XCTAssertTrue(cell.waitForExistence(timeout: 15), "the seeded item is not in the inventory")
        let layout = app.buttons["inventory.layout"]
        XCTAssertEqual(layout.label, "Show as list", "the grid is the default")

        layout.tap()
        XCTAssertTrue(cell.waitForExistence(timeout: 5))
        XCTAssertEqual(layout.label, "Show as grid")

        app.terminate()
        launchInventory(signedInTo: stack, reset: false)
        XCTAssertTrue(cell.waitForExistence(timeout: 15))
        XCTAssertEqual(app.buttons["inventory.layout"].label, "Show as grid", "the list was kept")
        cell.tap()
        XCTAssertTrue(app.staticTexts["item.sku"].waitForExistence(timeout: 15))
    }

    private func launchInventory(signedInTo stack: E2EStack, reset: Bool) {
        app.launchEnvironment = [
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": stack.token,
            "LISTORA_DEV_ACCESS_EMAIL": stack.email,
        ]
        if reset {
            app.launchEnvironment["LISTORA_RESET_LOCAL_DATA"] = "1"
        }
        app.launchQuietly()
        let inventory = app.tabRail.buttons["Inventory"]
        XCTAssertTrue(inventory.waitForExistence(timeout: 10))
        inventory.tap()
    }

    private func waitForAbsence(of element: XCUIElement, timeout: TimeInterval = 10) -> Bool {
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        return XCTWaiter().wait(for: [gone], timeout: timeout) == .completed
    }
}
