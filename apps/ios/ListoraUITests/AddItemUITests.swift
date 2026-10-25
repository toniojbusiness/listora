import XCTest

/// Drives the Add Item flow on the simulator: import fixture photos into a draft, set roles and
/// the cover, and find the draft unchanged after the app is relaunched. The simulator has no
/// camera, so photos come from `Fixtures/` through the app's debug fixture import (the same path as
/// the photo picker after selection). These tests never sign in, so the draft stays on the phone,
/// saying so; `ReviewFlowUITests` takes a draft through the local stack's API.
@MainActor
final class AddItemUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    private var fixturesPath: String {
        get throws {
            let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "Fixtures", withExtension: nil))
            return url.path(percentEncoded: false)
        }
    }

    private func launch(reset: Bool) throws {
        app.launchEnvironment = try ["LISTORA_FIXTURE_PHOTOS": fixturesPath]
        if reset {
            app.launchEnvironment["LISTORA_RESET_LOCAL_DATA"] = "1"
        }
        app.launch()
        let tab = app.tabBars.buttons["Add Item"]
        XCTAssertTrue(tab.waitForExistence(timeout: 10))
        tab.tap()
    }

    private func tile(_ index: Int) -> XCUIElement {
        app.buttons["photo.tile.\(index)"]
    }

    func testImportsFixturePhotosIntoADraftThatSurvivesRelaunch() throws {
        try launch(reset: true)
        XCTAssertTrue(app.staticTexts["Take photos once"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["draft.row"].exists, "the reset launch should start without drafts")

        app.buttons["addItem.importPhotos"].tap()

        // The new draft opens with the photos in order; roles follow the selection order.
        XCTAssertTrue(tile(2).waitForExistence(timeout: 15))
        XCTAssertTrue(tile(0).label.hasPrefix("Photo 1, Front, Cover"), tile(0).label)
        XCTAssertTrue(tile(1).label.hasPrefix("Photo 2, Back"), tile(1).label)
        XCTAssertTrue(tile(2).label.hasPrefix("Photo 3, Detail"), tile(2).label)
        XCTAssertFalse(tile(0).label.contains("Looks blurry"), tile(0).label)
        let summary = app.staticTexts["draft.uploadSummary"]
        XCTAssertEqual(summary.label, "Saved on this phone. Sign in to upload.")

        // The third photo is the tag.
        tile(2).tap()
        let role = app.segmentedControls["photo.role"]
        XCTAssertTrue(role.waitForExistence(timeout: 5))
        role.buttons["Tag"].tap()
        XCTAssertTrue(app.staticTexts["Listora reads the brand, size, and materials from tag photos on this iPhone."]
            .waitForExistence(timeout: 5))
        app.buttons["photo.done"].tap()
        XCTAssertTrue(waitForLabel(of: tile(2), prefix: "Photo 3, Tag"), tile(2).label)

        // The back becomes the cover.
        tile(1).tap()
        XCTAssertTrue(app.buttons["photo.makeCover"].waitForExistence(timeout: 5))
        app.buttons["photo.makeCover"].tap()
        app.buttons["photo.done"].tap()
        XCTAssertTrue(waitForLabel(of: tile(0), prefix: "Photo 1, Back, Cover"), tile(0).label)
        XCTAssertTrue(tile(1).label.hasPrefix("Photo 2, Front"), tile(1).label)

        // Back to the list: one draft with three photos.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let row = app.buttons["draft.row"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertTrue(row.label.contains("3 photos"), row.label)

        // A relaunch keeps the draft, its order, and its roles.
        app.terminate()
        try launch(reset: false)
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(tile(2).waitForExistence(timeout: 10))
        XCTAssertTrue(tile(0).label.hasPrefix("Photo 1, Back, Cover"), tile(0).label)
        XCTAssertTrue(tile(1).label.hasPrefix("Photo 2, Front"), tile(1).label)
        XCTAssertTrue(tile(2).label.hasPrefix("Photo 3, Tag"), tile(2).label)
        XCTAssertTrue(tile(2).label.hasSuffix("Sign in to upload"), tile(2).label)
    }

    func testRemovesAPhotoAndDeletesADraft() throws {
        try launch(reset: true)
        app.buttons["addItem.importPhotos"].tap()
        XCTAssertTrue(tile(2).waitForExistence(timeout: 15))

        tile(0).tap()
        XCTAssertTrue(app.buttons["photo.delete"].waitForExistence(timeout: 5))
        app.buttons["photo.delete"].tap()
        let remove = app.buttons["Remove"]
        XCTAssertTrue(remove.waitForExistence(timeout: 5))
        remove.tap()
        XCTAssertTrue(waitForLabel(of: tile(0), prefix: "Photo 1, Back, Cover"), tile(0).label)
        XCTAssertFalse(tile(2).exists)

        app.buttons["draft.more"].tap()
        let deleteDraft = app.buttons["Delete draft"]
        XCTAssertTrue(deleteDraft.waitForExistence(timeout: 5))
        deleteDraft.tap()
        let confirm = app.buttons["Delete"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(app.staticTexts["Take photos once"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["draft.row"].exists)
    }

    private func waitForLabel(of element: XCUIElement, prefix: String, timeout: TimeInterval = 5) -> Bool {
        let predicate = NSPredicate(format: "label BEGINSWITH %@", prefix)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }
}
