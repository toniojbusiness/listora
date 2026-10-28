import XCTest

extension XCUIApplication {
    /// The app's tab bar: DesignSystem's `TabRail`, drawn by the app in place of the system tab
    /// bar, so `tabBars` does not find it. Each tab is a button named by its title, the current one
    /// selected, with its badge as the value.
    var tabRail: XCUIElement {
        otherElements["tabRail"]
    }
}
