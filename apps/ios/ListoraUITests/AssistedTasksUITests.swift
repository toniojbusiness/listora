import XCTest

/// Assisted mode end to end against the local stack (packages/e2e): listing on Poshmark creates a
/// task in the Tasks tab (badged), with one-tap copy, the photos saved to the camera roll in
/// order, and a link to Poshmark; Done with the pasted listing link finishes it. Ending the
/// listing makes a delist task that opens the listing itself and ends with "Done - I removed it".
/// Every status the test waits for is the server's: an assisted listing only ever reads "you
/// confirmed", never "confirmed by Poshmark".
@MainActor
final class AssistedTasksUITests: XCTestCase {
    private let app = XCUIApplication()
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private let listingURL = "https://poshmark.com/listing/Levis-Trucker-Jacket-64f1a2b3c4d5e6f7a8b9c0d1"

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testListOnPoshmarkByTaskThenDelistByTask() async throws {
        let stack = try E2EStack.fromEnvironment()
        let item = try await stack.seedReadyItem()
        launch(signedInTo: stack)
        let status = openItem(sku: item.sku)

        listOnPoshmark(status: status)
        // Waiting for the user, with the task in the badged Tasks tab.
        XCTAssertTrue(waitForLabel(of: status, "Action needed - list on Poshmark", timeout: 30), status.label)
        XCTAssertTrue(app.buttons["marketplace.poshmark.action.openTask"].waitForExistence(timeout: 5))
        // The tab's badge (1) is drawn by the system tab bar, which doesn't expose it to UI
        // tests; the screenshot keeps it for review.
        keepScreenshot("Action needed, Tasks badged")

        app.tabBars.buttons["Tasks"].tap()
        let row = app.buttons["tasks.row.list_manually.poshmark.\(item.sku)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "the list task is not in the inbox")
        keepScreenshot("Task inbox")
        row.tap()
        finishListTask()

        // The task leaves the inbox (other tests' tasks may remain), and the item reads "you
        // confirmed".
        XCTAssertTrue(waitForAbsence(of: row, timeout: 15), "the done task is still in the inbox")
        keepScreenshot("Task done")
        showItem(sku: item.sku, status: status)
        XCTAssertTrue(waitForLabel(of: status, "Done (you confirmed)", timeout: 20), status.label)
        XCTAssertFalse(status.label.localizedCaseInsensitiveContains("confirmed by"))

        delistByTask(status: status)
        XCTAssertTrue(waitForLabel(of: status, "Done (you confirmed)", timeout: 20), status.label)
        XCTAssertTrue(app.buttons["marketplace.poshmark.action.relist"].waitForExistence(timeout: 10))
        keepScreenshot("Delisted by the user")
    }

    func testDismissingATaskShowsTheStepFailedWithRetry() async throws {
        let stack = try E2EStack.fromEnvironment()
        let item = try await stack.seedReadyItem()
        launch(signedInTo: stack)
        let status = openItem(sku: item.sku)
        listOnPoshmark(status: status)
        XCTAssertTrue(waitForLabel(of: status, "Action needed - list on Poshmark", timeout: 30), status.label)

        app.buttons["marketplace.poshmark.action.openTask"].tap()
        let dismiss = app.buttons["task.dismiss"]
        XCTAssertTrue(dismiss.waitForExistence(timeout: 15))
        dismiss.tap()
        app.buttons["task.dismiss.confirm"].firstMatch.tap()

        // Dismissing is never counted as done: the step failed, and Retry makes a new task.
        XCTAssertTrue(waitForLabel(of: status, "Publish failed - Retry", timeout: 20), status.label)
        keepScreenshot("Dismissed")
        app.buttons["marketplace.poshmark.action.retry"].tap()
        XCTAssertTrue(waitForLabel(of: status, "Action needed - list on Poshmark", timeout: 30), status.label)
    }

    // MARK: Steps

    private func openItem(sku: String) -> XCUIElement {
        let row = app.buttons["inventory.row.\(sku)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "the seeded item is not in the inventory")
        row.tap()
        let status = app.descendants(matching: .any)["marketplace.poshmark.status"]
        XCTAssertTrue(waitForLabel(of: status, "Not listed", timeout: 15), status.label)
        return status
    }

    /// Back to the item screen in the Inventory tab. On CI a tap on the tab once did not switch
    /// tabs while the done task's confirmation was still on screen, so the tab is tapped until it
    /// is selected, and the item opened from the list if the tab is back at its list.
    private func showItem(sku: String, status: XCUIElement) {
        let inventory = app.tabBars.buttons["Inventory"]
        for _ in 0 ..< 3 where !inventory.isSelected {
            inventory.tap()
            _ = status.waitForExistence(timeout: 2)
        }
        XCTAssertTrue(inventory.isSelected, "the Inventory tab did not open")
        guard !status.waitForExistence(timeout: 3) else { return }
        let row = app.buttons["inventory.row.\(sku)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "the item is not in the inventory")
        row.tap()
        XCTAssertTrue(status.waitForExistence(timeout: 15), "the item screen did not open")
    }

    /// List on the Poshmark row: Poshmark is chosen, its version reviewed, and a task created.
    private func listOnPoshmark(status _: XCUIElement) {
        let list = app.buttons["marketplace.poshmark.action.list"]
        list.swipeUpIfHidden(in: app)
        list.tap()
        let next = app.buttons["listing.next"]
        XCTAssertTrue(next.waitForExistence(timeout: 10))
        XCTAssertTrue(waitForEnabled(next), "Poshmark is not offered")
        next.tap()
        XCTAssertTrue(app.textFields["listing.title"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["listing.assistedNote"].exists)
        let send = app.buttons["listing.publish"]
        XCTAssertEqual(send.label, "Create Poshmark task")
        keepScreenshot("Poshmark listing")
        send.tap()
        XCTAssertTrue(waitForAbsence(of: send, timeout: 15), "the task was not created")
    }

    /// Copy, save the photos, open Poshmark, paste the link back, Done.
    private func finishListTask() {
        XCTAssertTrue(app.staticTexts["task.title"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["task.title"].label, "List on Poshmark")
        keepScreenshot("List task")

        app.buttons["task.copy.title"].tap()
        XCTAssertTrue(waitForLabel(
            of: app.descendants(matching: .any)["toast"],
            "Title copied",
            timeout: 5,
            contains: true,
        ))
        app.buttons["task.copy.price"].tap()

        // The steps scroll under the Done bar, so each one is brought clear of it before a tap:
        // a tap on a step behind the bar would land on Done and finish the task.
        let bar = app.buttons["task.done"]
        let save = app.buttons["task.savePhotos"]
        save.scrollClear(of: bar, in: app)
        save.tap()
        allowPhotoAccessIfAsked()
        XCTAssertTrue(app.descendants(matching: .any)["task.photosSaved"].waitForExistence(timeout: 30))

        // The link opens Poshmark (Safari in the simulator); come back to finish.
        let open = app.buttons["task.open"]
        open.scrollClear(of: bar, in: app)
        open.tap()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 15), "Poshmark did not open")
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        XCTAssertTrue(bar.waitForExistence(timeout: 5), "the task closed before Done")

        let link = app.textFields["task.link"]
        link.scrollClear(of: bar, in: app)
        link.tap()
        link.typeText(listingURL)
        keepScreenshot("Link pasted")
        app.buttons["task.done"].tap()
    }

    /// End the listing: a delist task that opens the listing itself; the user removes it.
    private func delistByTask(status: XCUIElement) {
        let end = app.buttons["marketplace.poshmark.action.end"]
        XCTAssertTrue(end.waitForExistence(timeout: 10))
        end.tap()
        let endButton = app.buttons["End: no longer available"].firstMatch
        XCTAssertTrue(endButton.waitForExistence(timeout: 5))
        endButton.tap()
        XCTAssertTrue(waitForLabel(of: status, "Action needed - delist on Poshmark", timeout: 30), status.label)

        app.buttons["marketplace.poshmark.action.openTask"].tap()
        let done = app.buttons["task.done"]
        XCTAssertTrue(done.waitForExistence(timeout: 15))
        XCTAssertEqual(done.label, "Done - I removed it")
        XCTAssertEqual(app.staticTexts["task.title"].label, "Delist on Poshmark")
        // The task opens the exact listing that was linked.
        XCTAssertTrue(app.staticTexts["poshmark.com"].exists)
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] 'confirmed by'")).firstMatch
            .exists)
        keepScreenshot("Delist task")
        done.tap()
        XCTAssertTrue(waitForAbsence(of: done, timeout: 15))
    }

    /// The first save asks for add-only photo access; the test allows it.
    private func allowPhotoAccessIfAsked() {
        let alert = springboard.alerts.firstMatch
        guard alert.waitForExistence(timeout: 5) else { return }
        let allow = alert.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Allow'")).firstMatch
        if allow.exists {
            allow.tap()
        } else {
            alert.buttons.element(boundBy: alert.buttons.count - 1).tap()
        }
    }

    private func launch(signedInTo stack: E2EStack) {
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": stack.token,
            "LISTORA_DEV_ACCESS_EMAIL": stack.email,
        ]
        app.launch()
        let inventory = app.tabBars.buttons["Inventory"]
        XCTAssertTrue(inventory.waitForExistence(timeout: 10))
        inventory.tap()
    }

    private func keepScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func waitForLabel(
        of element: XCUIElement,
        _ label: String,
        timeout: TimeInterval,
        contains: Bool = false,
    ) -> Bool {
        let predicate = NSPredicate(format: contains ? "label CONTAINS %@" : "label == %@", label)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }

    private func waitForEnabled(_ element: XCUIElement, timeout: TimeInterval = 10) -> Bool {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"),
            object: element,
        )
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }

    private func waitForAbsence(of element: XCUIElement, timeout: TimeInterval = 10) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }
}

extension XCUIElement {
    /// Scrolls the app up until the element is on screen (it may start below the fold).
    func swipeUpIfHidden(in app: XCUIApplication, attempts: Int = 5) {
        var left = attempts
        while !isHittable, left > 0 {
            app.swipeUp()
            left -= 1
        }
    }

    /// Scrolls the app until the element is on screen and wholly above `bar`, a bottom action bar
    /// the content scrolls under. XCUITest counts an element under such a bar as hittable, and
    /// taps the bar instead. Short drags, so the element doesn't overshoot past the top.
    func scrollClear(of bar: XCUIElement, in app: XCUIApplication, attempts: Int = 8) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        for _ in 0 ..< attempts {
            let barTop = bar.exists ? bar.frame.minY : app.frame.maxY
            if isHittable, frame.maxY <= barTop {
                return
            }
            // Below the bar, or off screen at the bottom: content up. Off screen at the top: down.
            let dy: CGFloat = frame.minY < app.frame.midY && !isHittable ? 200 : -200
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: dy)))
        }
        XCTFail("\(identifier) is not on screen above \(bar.identifier): \(frame)")
    }
}
