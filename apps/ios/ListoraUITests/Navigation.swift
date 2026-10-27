import XCTest

extension XCUIApplication {
    /// Taps the back button of the pushed screen titled `title` and waits until that screen has
    /// closed. `navigationBars.buttons.element(boundBy: 0)` is not always that back button: while
    /// the pushed screen's bar animates in, the first bar can still be the one below, and on CI
    /// its first button was Settings' Done, which closed the whole sheet.
    func goBack(from title: String) -> Bool {
        let bar = navigationBars[title]
        guard bar.waitForExistence(timeout: 5) else { return false }
        bar.buttons.element(boundBy: 0).tap()
        return bar.waitForNonExistence(timeout: 5)
    }
}
