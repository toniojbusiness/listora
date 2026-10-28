import XCTest

/// All the seller's sales on the Sales tab, against the real API (the local stack `make ios-test`
/// starts): sales recorded on two marketplaces add up on the price tag at the top exactly as the
/// server reports them, with each marketplace's own sales on its bead.
@MainActor
final class SalesSummaryUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testShowsAllSalesInTotalAndPerMarketplace() async throws {
        let stack = try E2EStack.fromEnvironment()
        let jacket = try await stack.seedReadyItem()
        let tee = try await stack.seedReadyItem()
        try await stack.recordSale(itemID: jacket.id, marketplace: "depop", priceCents: 3800)
        try await stack.recordSale(itemID: tee.id, marketplace: "mercari", priceCents: 1100)
        let expected = try await stack.salesSummary()
        XCTAssertGreaterThanOrEqual(expected.total.salesCount, 2)
        launch(signedInTo: stack)

        app.tabRail.buttons["Sales"].tap()
        let total = app.descendants(matching: .any)["sales.summary.total"]
        XCTAssertTrue(total.waitForExistence(timeout: 15))
        XCTAssertTrue(total.label.contains(Self.money(expected.total.revenue.amountCents)), total.label)
        for marketplace in ["depop", "mercari"] {
            let shown = try XCTUnwrap(expected.marketplaces.first { $0.marketplace == marketplace })
            let row = app.descendants(matching: .any)["sales.summary.\(marketplace)"]
            XCTAssertTrue(row.waitForExistence(timeout: 5))
            XCTAssertTrue(row.label.contains(Self.money(shown.revenue.amountCents)), row.label)
        }
        keepScreenshot("Sales summary")
    }

    // MARK: Helpers

    /// "$12.50", as the app formats money.
    private static func money(_ cents: Int) -> String {
        (Decimal(cents) / 100).formatted(.currency(code: "USD"))
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
}
