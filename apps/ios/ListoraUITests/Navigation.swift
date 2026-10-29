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

extension XCUIElement {
    /// Taps until `opened` exists, up to `attempts` times. Right after a swipe the scroll view may
    /// still be settling, and a tap then only stops the scroll: the screen stays where it was
    /// (ReportsUITests' Reports entry, October 2026 CI).
    func tap(until opened: XCUIElement, attempts: Int = 3, timeout: TimeInterval = 10) -> Bool {
        for _ in 0 ..< attempts {
            tap()
            if opened.waitForExistence(timeout: timeout) {
                return true
            }
        }
        return false
    }
}
