import XCTest

/// The profit dashboard against the real API (the local stack `make ios-test` starts): a sale
/// recorded through the API shows up in this month's totals exactly as the server reports them,
/// with the seller's own marketplace row and dead stock, and the period picker moves to the year.
@MainActor
final class ProfitDashboardUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testShowsTheServersTotalsForThePeriod() async throws {
        let stack = try E2EStack.fromEnvironment()
        let item = try await stack.seedReadyItem()
        try await stack.recordSale(itemID: item.id, marketplace: "mercari", priceCents: 4500)
        let month = Self.thisMonth()
        let expected = try await stack.profitSummary(
            firstDay: month.firstDay,
            lastDay: month.lastDay,
            timeZone: TimeZone.current.identifier,
        )
        XCTAssertGreaterThanOrEqual(expected.salesCount, 1)
        launch(signedInTo: stack)

        app.tabRail.buttons["Sales"].tap()
        let entry = app.buttons["sales.profit"]
        XCTAssertTrue(entry.waitForExistence(timeout: 15))
        entry.tap()

        // The month's totals, as the server computed them.
        let netProfit = app.staticTexts["profit.netProfit"]
        XCTAssertTrue(netProfit.waitForExistence(timeout: 15))
        XCTAssertTrue(netProfit.label.hasSuffix(Self.money(expected.netProfit.amountCents)), netProfit.label)
        let revenue = app.descendants(matching: .any)["profit.revenue"]
        XCTAssertTrue(revenue.label.contains(Self.money(expected.revenue.amountCents)), revenue.label)
        let sales = app.descendants(matching: .any)["profit.salesCount"]
        XCTAssertTrue(sales.label.contains("\(expected.salesCount)"), sales.label)
        keepScreenshot("Profit")

        // The chart of the month, by day.
        let chart = app.descendants(matching: .any)["profit.chart"]
        scrollTo(chart)
        keepScreenshot("Profit chart")

        // The seller's own marketplace totals, and dead stock.
        let mercari = app.descendants(matching: .any)["profit.marketplace.mercari"]
        scrollTo(mercari)
        XCTAssertTrue(mercari.label.contains("Mercari"), mercari.label)
        let deadStock = app.descendants(matching: .any)["profit.deadStock.over60"]
        scrollTo(deadStock)
        XCTAssertTrue(deadStock.label.contains("Over 60 days"), deadStock.label)
        keepScreenshot("Profit breakdowns")

        // The year: the period moves, and the next year is not offered.
        app.swipeDown()
        app.swipeDown()
        app.buttons["profit.range.year"].tap()
        let period = app.staticTexts["profit.period"]
        let year = String(Calendar.current.component(.year, from: Date()))
        XCTAssertTrue(waitForLabel(of: period, year, timeout: 10), period.label)
        XCTAssertFalse(app.buttons["profit.next"].isEnabled)
        XCTAssertTrue(netProfit.waitForExistence(timeout: 15))
        keepScreenshot("Profit year")
    }

    // MARK: Helpers

    /// The first and last day of this month, `YYYY-MM-DD`, as the app asks for them.
    private static func thisMonth() -> (firstDay: String, lastDay: String) {
        let calendar = Calendar.current
        let interval = calendar.dateInterval(of: .month, for: Date()) ?? DateInterval()
        let last = calendar.date(byAdding: .day, value: -1, to: interval.end) ?? interval.end
        return (day(interval.start, calendar), day(last, calendar))
    }

    private static func day(_ date: Date, _ calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// "$12.50", as the app formats money.
    private static func money(_ cents: Int) -> String {
        (Decimal(cents) / 100).formatted(.currency(code: "USD"))
    }

    private func scrollTo(_ element: XCUIElement) {
        for _ in 0 ..< 8 where !(element.exists && element.isHittable) {
            app.swipeUp()
        }
        XCTAssertTrue(element.waitForExistence(timeout: 5))
    }

    private func launch(signedInTo stack: E2EStack) {
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": stack.token,
            "LISTORA_DEV_ACCESS_EMAIL": stack.email,
        ]
        app.launch()
        XCTAssertTrue(app.tabRail.buttons["Inventory"].waitForExistence(timeout: 10))
    }

    /// Keeps a screenshot in the result bundle, passing or not, for reviewing the screens.
    private func keepScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func waitForLabel(of element: XCUIElement, _ label: String, timeout: TimeInterval) -> Bool {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", label),
            object: element,
        )
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }
}
