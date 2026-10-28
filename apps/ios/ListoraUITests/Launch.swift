import XCTest

extension XCUIApplication {
    /// Launches with the unified log kept off stderr. XCTest runs the app with
    /// `OS_ACTIVITY_DT_MODE`, which copies every log line (XCTest's own, several per query) to
    /// the app's stderr, a terminal the runner drains. On a busy CI runner the app blocked
    /// writing them in the middle of answering a query, so the query (and the test) hung.
    func launchQuietly() {
        launchEnvironment["OS_ACTIVITY_DT_MODE"] = "NO"
        launch()
    }
}
