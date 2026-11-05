import XCTest

/// The thrift scan tests' waits for the app's own work: a shot's read and a kept item's draft.
/// Each follows what the screen says the app is still doing instead of a fixed time, so a loaded
/// machine (CI's macOS runners have taken 50 s for a read) slows the test without failing it,
/// and a real failure ends the wait at once with what the app said.
extension ThriftScanUITests {
    /// The longest a shot's read may honestly take: the app's own request timeouts (URLSession's
    /// 60 s) for its two requests, the run's creation and the scan. On a loaded CI runner the read
    /// has taken 50 s (PR #239's first run), so a fixed 20 s was not what the test needed.
    static let readDeadline: TimeInterval = 120

    /// Waits for shot `number`'s read to land, by what its card says, and returns whether Keep is
    /// there. While the card says "Reading item N" the read is still on its way, so the wait
    /// follows it; a card that says the read failed ends the wait at once, with its message.
    @discardableResult
    func waitForTheRead(of number: Int, file: StaticString = #filePath, line: UInt = #line) -> Bool {
        let keep = app.buttons["scan.keep"]
        let failed = app.staticTexts["Couldn't read item \(number)"]
        guard waitUntil({ keep.exists || failed.exists }) else {
            XCTFail("item \(number) was still reading after \(Int(Self.readDeadline)) s", file: file, line: line)
            return false
        }
        if !keep.exists {
            XCTFail("item \(number)'s read failed: \(element("scan.card").label)", file: file, line: line)
            return false
        }
        return true
    }

    /// Waits for Keep to finish saving item `number`'s draft on this iPhone, until the camera's
    /// summary reads `summary`. While the line over the camera says "Keeping item N" the keep is
    /// waiting for the upload-sized photo (prepared at utility priority, the first work a loaded
    /// machine starves), so the wait follows it; a failed keep ends the wait at once.
    @discardableResult
    func waitForTheKeep(
        of number: Int, summary: String, file: StaticString = #filePath, line: UInt = #line,
    ) -> Bool {
        let counts = element("scanCamera.summary")
        let failed = element("scan.keepFailed")
        let confirmation = element("scan.confirmation")
        let kept = { counts.exists && counts.label.hasPrefix(summary) }
        let lineFailed = { confirmation.exists && confirmation.label.hasPrefix("Couldn't") }
        guard waitUntil({ kept() || failed.exists || lineFailed() }) else {
            let left = counts.label
            XCTFail("item \(number) was not kept after \(Int(Self.readDeadline)) s: \(left)", file: file, line: line)
            return false
        }
        if kept() {
            return true
        }
        let why = failed.exists ? failed.label : confirmation.label
        XCTFail("keeping item \(number) failed: \(why)", file: file, line: line)
        return false
    }

    /// Waits up to ``readDeadline`` for `condition`, checked about every second.
    private func waitUntil(_ condition: @escaping () -> Bool) -> Bool {
        let predicate = NSPredicate { _, _ in condition() }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        return XCTWaiter().wait(for: [expectation], timeout: Self.readDeadline) == .completed
    }

    func waitForLabel(of element: XCUIElement, prefix: String, timeout: TimeInterval = 10) -> Bool {
        let predicate = NSPredicate(format: "label BEGINSWITH %@", prefix)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }

    func waitUntilEnabled(_ element: XCUIElement, timeout: TimeInterval = 10) -> Bool {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"),
            object: element,
        )
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }
}
