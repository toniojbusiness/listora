import XCTest

/// The Reports screen against the real API (the local stack `make ios-test` starts): a sale
/// recorded through the API shows up in this year's revenue exactly as the server reports it,
/// with the seller's own marketplace row, the next year is not offered, and the year's sales
/// export is prepared as a file ready to share.
@MainActor
final class ReportsUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testShowsTheServersYearAndPreparesTheSalesFile() async throws {
        let stack = try E2EStack.fromEnvironment()
        let item = try await stack.seedReadyItem()
        try await stack.recordSale(itemID: item.id, marketplace: "mercari", priceCents: 4500)
        let year = Calendar.current.component(.year, from: Date())
        let expected = try await yearRevenueCents(stack, year: year)
        XCTAssertGreaterThanOrEqual(expected, 4500)
        launch(signedInTo: stack)

        app.tabRail.buttons["Sales"].tap()
        let entry = app.buttons["sales.reports"]
        scrollTo(entry)
        let shownYear = app.staticTexts["reports.year"]
        XCTAssertTrue(entry.tap(until: shownYear), "Reports did not open")

        // The year's revenue, as the server computed it, and no year after this one.
        let revenue = app.descendants(matching: .any)["reports.revenue"]
        XCTAssertTrue(revenue.waitForExistence(timeout: 15))
        XCTAssertTrue(revenue.label.contains(Self.money(expected)), revenue.label)
        XCTAssertEqual(shownYear.label, String(year))
        XCTAssertFalse(app.buttons["reports.next"].isEnabled)
        keepScreenshot("Reports")

        // The seller's own Mercari totals.
        let mercari = app.descendants(matching: .any)["reports.marketplace.mercari"]
        scrollTo(mercari)
        XCTAssertTrue(mercari.label.contains("Mercari"), mercari.label)

        // The sales file for the year, saved and ready for the share sheet.
        let prepare = app.buttons["reports.export.sales.prepare"]
        scrollTo(prepare)
        prepare.tap()
        let share = app.buttons["reports.export.sales.share"]
        XCTAssertTrue(share.waitForExistence(timeout: 15))
        let fileName = app.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH %@", "listora-sales-\(year).csv"),
        ).firstMatch
        XCTAssertTrue(fileName.waitForExistence(timeout: 5))
        keepScreenshot("Reports exports")
    }

    // MARK: Helpers

    /// The year's revenue, as the API reports it (`getYearReport`).
    private func yearRevenueCents(_ stack: E2EStack, year: Int) async throws -> Int {
        var components = URLComponents(
            url: stack.apiURL.appending(path: "v1/reports/year"),
            resolvingAgainstBaseURL: false,
        )
        components?.queryItems = [
            URLQueryItem(name: "year", value: String(year)),
            URLQueryItem(name: "timeZone", value: TimeZone.current.identifier),
        ]
        var request = try URLRequest(url: XCTUnwrap(components?.url))
        request.setValue("Bearer \(stack.token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, String(bytes: data, encoding: .utf8) ?? "")
        return try JSONDecoder().decode(ReportsYearBody.self, from: data).total.revenue.amountCents
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
        app.launchQuietly()
        XCTAssertTrue(app.tabRail.buttons["Inventory"].waitForExistence(timeout: 10))
    }

    /// Keeps a screenshot in the result bundle, passing or not, for reviewing the screens.
    private func keepScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

/// The parts of the contract's `YearReport` the test checks.
private struct ReportsYearBody: Decodable {
    let total: ReportsYearTotals
}

private struct ReportsYearTotals: Decodable {
    let revenue: SavedMoney
}
