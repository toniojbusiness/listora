import XCTest

/// Drives the guided capture with the debug fake camera (`LISTORA_FAKE_CAMERA`), which "takes" the
/// fixture photos in order, because the simulator has no camera: front, back, and tag in one tap
/// each, then Done saves a draft whose photos have those roles.
@MainActor
final class CameraCaptureUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
        let fixtures = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "Fixtures", withExtension: nil))
        app.launchEnvironment = [
            "LISTORA_FAKE_CAMERA": fixtures.path(percentEncoded: false),
            "LISTORA_RESET_LOCAL_DATA": "1",
        ]
        app.launch()
        let tab = app.tabBars.buttons["Add"]
        XCTAssertTrue(tab.waitForExistence(timeout: 10))
        tab.tap()
    }

    private var stepTitle: XCUIElement {
        app.staticTexts["camera.stepTitle"]
    }

    private func waitForStep(_ title: String) -> Bool {
        let predicate = NSPredicate(format: "label == %@", title)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: stepTitle)
        return XCTWaiter().wait(for: [expectation], timeout: 10) == .completed
    }

    func testGuidedShotsBecomeADraftWithTheirRoles() {
        app.buttons["addItem.takePhotos"].tap()
        let shutter = app.buttons["camera.shutter"]
        XCTAssertTrue(shutter.waitForExistence(timeout: 10))
        XCTAssertTrue(waitForStep("Front"), stepTitle.label)
        XCTAssertEqual(shutter.label, "Take front photo")
        XCTAssertFalse(app.buttons["camera.done"].isEnabled, "Done needs at least one photo")

        shutter.tap()
        XCTAssertTrue(waitForStep("Back"), stepTitle.label)
        shutter.tap()
        XCTAssertTrue(waitForStep("Tag"), stepTitle.label)
        shutter.tap()
        XCTAssertTrue(waitForStep("Flaws & details"), stepTitle.label)
        XCTAssertTrue(app.buttons["camera.step.1"].label.hasSuffix("1 taken"), app.buttons["camera.step.1"].label)

        let done = app.buttons["camera.done"]
        XCTAssertTrue(done.isEnabled)
        done.tap()

        let tile = { (index: Int) in self.app.buttons["photo.tile.\(index)"] }
        XCTAssertTrue(tile(2).waitForExistence(timeout: 15))
        XCTAssertTrue(tile(0).label.hasPrefix("Photo 1, Front, Cover"), tile(0).label)
        XCTAssertTrue(tile(1).label.hasPrefix("Photo 2, Back"), tile(1).label)
        XCTAssertTrue(tile(2).label.hasPrefix("Photo 3, Tag"), tile(2).label)
    }

    func testSkippingAndCancellingKeepNothing() {
        app.buttons["addItem.takePhotos"].tap()
        let shutter = app.buttons["camera.shutter"]
        XCTAssertTrue(shutter.waitForExistence(timeout: 10))

        // Skip the front, shoot the back, then cancel: the seller is asked before photos are lost.
        app.buttons["camera.skip"].tap()
        XCTAssertTrue(waitForStep("Back"), stepTitle.label)
        shutter.tap()
        XCTAssertTrue(waitForStep("Tag"), stepTitle.label)
        app.buttons["camera.cancel"].tap()
        let discard = app.buttons["Discard photos"]
        XCTAssertTrue(discard.waitForExistence(timeout: 5))
        discard.tap()

        XCTAssertTrue(app.staticTexts["Take photos once"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["draft.row"].exists)
    }
}
