import XCTest

extension XCUIApplication {
    /// Taps the back button of the pushed screen titled `title` and waits until that screen has
    /// closed. `navigationBars.buttons.element(boundBy: 0)` names no bar, so while a pushed bar
    /// animates in it can be a button of the bar below, such as a sheet's Done.
    func goBack(from title: String) -> Bool {
        let bar = navigationBars[title]
        guard bar.waitForExistence(timeout: 5) else { return false }
        bar.buttons.element(boundBy: 0).tap()
        return bar.waitForNonExistence(timeout: 5)
    }
}
