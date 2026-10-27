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
        try launch(signedInTo: stack)
        let status = try openItem(sku: item.sku)

        try listOnPoshmark(status: status)
        // Waiting for the user, with the task in the badged Tasks tab.
        try require(waitForLabel(of: status, "Action needed - list on Poshmark", timeout: 30), status.label)
        try require(app.buttons["marketplace.poshmark.action.openTask"].waitForExistence(timeout: 5))
        // The tab's badge (1) is drawn by the system tab bar, which doesn't expose it to UI
        // tests; the screenshot keeps it for review.
        keepScreenshot("Action needed, Tasks badged")

        app.tabBars.buttons["Tasks"].tap()
        let row = app.buttons["tasks.row.list_manually.poshmark.\(item.sku)"]
        try require(row.waitForExistence(timeout: 15), "the list task is not in the inbox")
        keepScreenshot("Task inbox")
        row.tap()
        try finishListTask()

        // The task leaves the inbox (other tests' tasks may remain), and the item reads "you
        // confirmed".
        try require(row.waitForNonExistence(timeout: 15), "the done task is still in the inbox")
        keepScreenshot("Task done")
        try showItem(sku: item.sku, status: status)
        try require(waitForLabel(of: status, "Done (you confirmed)", timeout: 20), status.label)
        try require(!status.label.localizedCaseInsensitiveContains("confirmed by"), status.label)

        try delistByTask(status: status)
        try require(waitForLabel(of: status, "Done (you confirmed)", timeout: 20), status.label)
        try require(app.buttons["marketplace.poshmark.action.relist"].waitForExistence(timeout: 10))
        keepScreenshot("Delisted by the user")
    }

    func testDismissingATaskShowsTheStepFailedWithRetry() async throws {
        let stack = try E2EStack.fromEnvironment()
        let item = try await stack.seedReadyItem()
        try launch(signedInTo: stack)
        let status = try openItem(sku: item.sku)
        try listOnPoshmark(status: status)
        try require(waitForLabel(of: status, "Action needed - list on Poshmark", timeout: 30), status.label)

        app.buttons["marketplace.poshmark.action.openTask"].tap()
        let dismiss = app.buttons["task.dismiss"]
        try require(dismiss.waitForExistence(timeout: 15))
        dismiss.tap()
        app.buttons["task.dismiss.confirm"].firstMatch.tap()

        // Dismissing is never counted as done: the step failed, and Retry makes a new task.
        try require(waitForLabel(of: status, "Publish failed - Retry", timeout: 20), status.label)
        keepScreenshot("Dismissed")
        app.buttons["marketplace.poshmark.action.retry"].tap()
        try require(waitForLabel(of: status, "Action needed - list on Poshmark", timeout: 30), status.label)
    }

    // MARK: Steps

    private func openItem(sku: String) throws -> XCUIElement {
        let row = app.buttons["inventory.row.\(sku)"]
        try require(row.waitForExistence(timeout: 15), "the seeded item is not in the inventory")
        row.tap()
        let status = app.descendants(matching: .any)["marketplace.poshmark.status"]
        try require(waitForLabel(of: status, "Not listed", timeout: 15), status.label)
        return status
    }

    /// Back to the item screen in the Inventory tab. On CI a tap on the tab once did not switch
    /// tabs while the done task's confirmation was still on screen, so the tab is tapped until it
    /// is selected, and the item opened from the list if the tab is back at its list.
    private func showItem(sku: String, status: XCUIElement) throws {
        let inventory = app.tabBars.buttons["Inventory"]
        for _ in 0 ..< 3 where !inventory.isSelected {
            inventory.tap()
            _ = status.waitForExistence(timeout: 2)
        }
        try require(inventory.isSelected, "the Inventory tab did not open")
        guard !status.waitForExistence(timeout: 3) else { return }
        let row = app.buttons["inventory.row.\(sku)"]
        try require(row.waitForExistence(timeout: 15), "the item is not in the inventory")
        row.tap()
        try require(status.waitForExistence(timeout: 15), "the item screen did not open")
    }

    /// List on the Poshmark row: Poshmark is chosen, its version reviewed, and a task created.
    private func listOnPoshmark(status _: XCUIElement) throws {
        let list = app.buttons["marketplace.poshmark.action.list"]
        list.swipeUpIfHidden(in: app)
        list.tap()
        let next = app.buttons["listing.next"]
        try require(next.waitForExistence(timeout: 10))
        try require(waitForEnabled(next), "Poshmark is not offered")
        next.tap()
        try require(app.textFields["listing.title"].waitForExistence(timeout: 5))
        try require(app.descendants(matching: .any)["listing.assistedNote"].exists)
        let send = app.buttons["listing.publish"]
        try require(send.label == "Create Poshmark task", send.label)
        keepScreenshot("Poshmark listing")
        send.tap()
        try require(send.waitForNonExistence(timeout: 30), "the task was not created")
    }

    /// Copy, save the photos, open Poshmark, paste the link back, Done.
    private func finishListTask() throws {
        try require(app.staticTexts["task.title"].waitForExistence(timeout: 10))
        try require(app.staticTexts["task.title"].label == "List on Poshmark", app.staticTexts["task.title"].label)
        keepScreenshot("List task")

        app.buttons["task.copy.title"].tap()
        try require(waitForLabel(
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
        try allowPhotoAccessIfAsked()
        try require(app.descendants(matching: .any)["task.photosSaved"].waitForExistence(timeout: 30))

        // The link opens Poshmark (Safari in the simulator); come back to finish.
        let open = app.buttons["task.open"]
        open.scrollClear(of: bar, in: app)
        open.tap()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        try require(safari.wait(for: .runningForeground, timeout: 15), "Poshmark did not open")
        app.activate()
        try require(app.wait(for: .runningForeground, timeout: 10))
        try require(bar.waitForExistence(timeout: 5), "the task closed before Done")

        let link = app.textFields["task.link"]
        link.scrollClear(of: bar, in: app)
        try require(link.typeChecked(listingURL), "the link field holds \(link.value ?? "nothing")")
        keepScreenshot("Link pasted")
        try require(bar.isEnabled, "Done is off with the link \(link.value ?? "")")
        bar.tap()
        try require(app.staticTexts["task.title"].waitForNonExistence(timeout: 15), "the task did not close on Done")
    }

    /// End the listing: a delist task that opens the listing itself; the user removes it.
    private func delistByTask(status: XCUIElement) throws {
        let end = app.buttons["marketplace.poshmark.action.end"]
        try require(end.waitForExistence(timeout: 10))
        end.tap()
        let endButton = app.buttons["End: no longer available"].firstMatch
        try require(endButton.waitForExistence(timeout: 5))
        endButton.tap()
        try require(waitForLabel(of: status, "Action needed - delist on Poshmark", timeout: 30), status.label)

        app.buttons["marketplace.poshmark.action.openTask"].tap()
        let done = app.buttons["task.done"]
        try require(done.waitForExistence(timeout: 15))
        try require(done.label == "Done - I removed it", done.label)
        try require(app.staticTexts["task.title"].label == "Delist on Poshmark", app.staticTexts["task.title"].label)
        // The task opens the exact listing that was linked.
        try require(app.staticTexts["poshmark.com"].exists)
        try require(
            !app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] 'confirmed by'")).firstMatch.exists,
            "the delist task claims Poshmark confirmed it",
        )
        keepScreenshot("Delist task")
        done.tap()
        try require(done.waitForNonExistence(timeout: 15))
    }

    /// The first save asks for add-only photo access (every run: `launch` resets it); the test
    /// allows it. On a slow simulator (CI) a tap while the alert is still animating in is
    /// dropped and the alert stays up, so the save waits on it forever: the tap is repeated
    /// until the alert has closed.
    private func allowPhotoAccessIfAsked() throws {
        let alert = springboard.alerts.firstMatch
        guard alert.waitForExistence(timeout: 10) else { return }
        for _ in 0 ..< 3 {
            let allow = alert.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Allow'")).firstMatch
            let button = allow.exists ? allow : alert.buttons.element(boundBy: alert.buttons.count - 1)
            _ = waitForHittable(button)
            button.tap()
            if alert.waitForNonExistence(timeout: 3) {
                return
            }
        }
        try require(false, "the photo access alert did not close")
    }

    private func launch(signedInTo stack: E2EStack) throws {
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": stack.token,
            "LISTORA_DEV_ACCESS_EMAIL": stack.email,
        ]
        // A simulator that already allowed it never asks; CI's is erased before every run and
        // always asks. Resetting makes every run take the asking path, the one that can break.
        app.resetAuthorizationStatus(for: .photos)
        app.launch()
        let inventory = app.tabBars.buttons["Inventory"]
        try require(inventory.waitForExistence(timeout: 10))
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

    private func waitForHittable(_ element: XCUIElement, timeout: TimeInterval = 5) -> Bool {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isHittable == true"),
            object: element,
        )
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
