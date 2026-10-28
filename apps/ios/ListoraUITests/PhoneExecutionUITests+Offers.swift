import XCTest

/// A buyer's offer in Tasks (docs/features/offers.md), against the local stack: this iPhone reads
/// the offers on the fake Depop read-only, the offer shows up as a task with its amount and what
/// accepting gives after fees, and Accept sends one answer only after its confirmation, shown as
/// done only once the phone's read of the offer shows it. Never a real buyer's offer.
extension PhoneExecutionUITests {
    func testAcceptsABuyersOfferFromTasksOnlyAfterItsConfirmation() async throws {
        let stack = try await freshStack()
        launch(stack, reset: true)
        openLinkAccounts()
        try await link()

        // A listing of the seller's on Depop, and a buyer's $30 offer on it there.
        let seeded = try await stack.seedQueuedDepopListing()
        try await waitFor("the listing to go live", timeout: 120) {
            try await stack.listing(id: seeded.listingId).status == "active"
        }
        let products = try await stack.depopProducts()
        let product = try XCTUnwrap(products.last)
        try await stack.addDepopOffer(slug: product.slug, amountCents: 3000)

        // Opening Tasks reads the offers on this iPhone; the offer becomes a task.
        app.terminate()
        launch(stack, reset: false)
        let tasks = app.tabRail.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 30), "no Tasks tab\n\(app.debugDescription)")
        tasks.tap()
        let row = app.buttons["tasks.row.answer_offer.depop.\(seeded.sku)"]
        try await waitFor("the offer's task", timeout: 120) {
            if row.exists {
                return true
            }
            // Pull to refresh reads the inbox again once the phone has read the offers.
            app.swipeDown()
            return false
        }
        snapshot("offers-1-task")
        row.tap()

        XCTAssertTrue(element("offer.amount").waitForExistence(timeout: 20), "no offer\n\(app.debugDescription)")
        XCTAssertEqual(element("offer.amount").label, "$30.00")
        XCTAssertTrue(element("offer.net").label.contains("after Depop's fees"))
        snapshot("offers-2-offer")

        // Accept asks first, with the amount and the net; nothing is sent before.
        app.buttons["offer.accept"].tap()
        let confirm = app.buttons["offer.confirm"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 10), "no confirmation\n\(app.debugDescription)")
        snapshot("offers-3-confirmation")
        let sentBefore = try await stack.depopOfferAnswers()
        XCTAssertEqual(sentBefore, [])
        confirm.tap()

        // Done only once the phone's read of the offer shows it accepted.
        let status = element("offer.status")
        let accepted = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label CONTAINS %@", "Accepted (confirmed by Depop)"),
            object: status,
        )
        await fulfillment(of: [accepted], timeout: 120)
        snapshot("offers-4-accepted")
        let sent = try await stack.depopOfferAnswers()
        XCTAssertEqual(sent.map(\.action), ["accept"])
    }
}
