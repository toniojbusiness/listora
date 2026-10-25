import XCTest

/// Drives a fixture item from a draft through review and price to a saved inventory item with a
/// SKU, against the real API and worker with the fake AI provider: the local stack
/// `make ios-test` starts (`npm run e2e:stack`, packages/e2e), which signs in a test user and
/// hands its URL and session to this test through xcodebuild's `TEST_RUNNER_` variables. The
/// fake AI answers every photo set with `FakeAI/default.json`: a shirt whose brand and color are
/// uncertain.
@MainActor
final class ReviewFlowUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testAFixtureItemGoesFromDraftThroughReviewAndPriceToASavedItemWithASKU() async throws {
        let stack = try E2EStack.fromEnvironment()
        try launch(signedInTo: stack)
        createDraftAndOpenReview()
        reviewConfidenceFirst()
        identifyHarder()
        enterSize()
        enterCost()
        let sku = choosePriceAndSave()

        // The server has the inventory item as saved.
        let item = try await stack.item(sku: sku)
        XCTAssertEqual(item.status, "ready")
        XCTAssertEqual(item.details.listPrice?.amountCents, 2600)
        XCTAssertEqual(item.details.cost?.amountCents, 1200)
        XCTAssertEqual(item.details.purchaseSource, "Goodwill")
        XCTAssertEqual(item.details.colors, ["navy"])
        XCTAssertEqual(item.fieldProvenance["colors"], "user")
        XCTAssertEqual(item.details.sizeLabel, "M")
        XCTAssertNotNil(item.details.floorPrice)

        // Done: back to Add Item, where the saved item's draft is gone.
        app.buttons["saved.done"].tap()
        XCTAssertTrue(app.staticTexts["Take photos once"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["draft.row"].exists)

        // The saved item is in the inventory right away, ready to list.
        app.tabBars.buttons["Inventory"].tap()
        let row = app.buttons["inventory.row.\(sku)"]
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the saved item is not in the inventory")
        XCTAssertFalse(app.staticTexts["No items yet"].exists)
        keepScreenshot("Inventory")
    }

    /// The seller holds the talk button and says one correction; the simulator has no microphone,
    /// so the app "hears" `LISTORA_VOICE_TRANSCRIPT`. The phone's own parser maps the routine
    /// phrases, the one it can't goes to the API's text model (the fake AI answers it from
    /// `FakeAI/default.json`), and every change waits as a chip until the seller accepts it.
    func testASpokenCorrectionIsProposedAsChipsAndAcceptedAsTheSellersOwnEdits() async throws {
        let stack = try E2EStack.fromEnvironment()
        try launch(signedInTo: stack, environment: [
            "LISTORA_VOICE_TRANSCRIPT": "Size medium, small stain on the left cuff, paid four dollars at Goodwill, "
                + "it has a tiny embroidered logo",
        ])
        createDraftAndOpenReview()
        let sku = try XCTUnwrap(
            app.navigationBars.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "[A-Z0-9]{1,8}-[0-9]{6,}"))
                .firstMatch.label,
        )
        speakACorrection()
        acceptAndUndo()
        correctFast()

        // The cost screen starts from what was said, and the server has the seller's edits.
        app.buttons["review.continue"].tap()
        let amount = app.staticTexts["cost.amount"]
        XCTAssertTrue(amount.waitForExistence(timeout: 10))
        XCTAssertEqual(amount.value as? String, "$4")
        XCTAssertEqual(app.textFields["cost.source"].value as? String, "Goodwill")
        app.buttons["cost.continue"].tap()
        XCTAssertTrue(app.staticTexts["price.estimateLabel"].waitForExistence(timeout: 15))

        let item = try await stack.item(sku: sku)
        XCTAssertEqual(item.details.sizeLabel, "M")
        XCTAssertEqual(item.fieldProvenance["sizeLabel"], "user")
        XCTAssertEqual(item.details.flaws, ["Small stain on the left cuff"])
        XCTAssertEqual(item.details.keywords, ["button up", "casual", "embroidered logo"])
        XCTAssertEqual(item.details.pattern, "striped")
        XCTAssertEqual(item.details.cost?.amountCents, 400)
        XCTAssertEqual(item.details.purchaseSource, "Goodwill")
    }

    // MARK: Voice steps

    /// Holds the talk button: the first hold explains what voice needs, the next one is heard.
    /// The routine phrases are chips at once; the logo phrase comes back from the text model.
    private func speakACorrection() {
        let talk = app.descendants(matching: .any)["voice.talk"]
        talk.press(forDuration: 0.5)
        let allow = app.buttons["voice.noticeAction"]
        XCTAssertTrue(allow.waitForExistence(timeout: 5))
        XCTAssertEqual(allow.label, "Turn on voice")
        allow.tap()
        talk.press(forDuration: 1)

        let aiChip = app.descendants(matching: .any)["voice.proposal.5"]
        XCTAssertTrue(aiChip.waitForExistence(timeout: 20), "the text model's change never arrived")
        let chips = (0 ... 5).map { app.descendants(matching: .any)["voice.proposal.\($0)"].label }
        XCTAssertEqual(chips, [
            "Size: M",
            "Size type: Letter (XS to XXXL)",
            "Flaws: + Small stain on the left cuff",
            "Paid: $4.00",
            "Bought at: Goodwill",
            "Keywords: + embroidered logo, understood by Listora AI",
        ])
        // Nothing changed yet.
        let size = app.buttons["review.field.sizeLabel"]
        XCTAssertTrue(waitForLabel(of: size, prefix: "Size, No value"), size.label)
        keepScreenshot("Voice proposals")
    }

    /// Accepting makes each change the seller's; undo takes one back and offers it again.
    private func acceptAndUndo() {
        app.buttons["voice.acceptAll"].tap()
        let size = app.buttons["review.field.sizeLabel"]
        XCTAssertTrue(waitForLabel(of: size, prefix: "Size, M, From You"), size.label)
        let flaws = scrolledTo(app.buttons["review.field.flaws"])
        XCTAssertTrue(waitForLabel(of: flaws, prefix: "Flaws, Small stain on the left cuff, From You"), flaws.label)
        let keywords = scrolledTo(app.buttons["review.field.keywords"], upward: true)
        XCTAssertTrue(waitForLabel(of: keywords, prefix: "Keywords, button up, casual, embroidered logo, From You"))
        keepScreenshot("Voice accepted")

        app.buttons["voice.undo.0"].tap()
        XCTAssertTrue(app.buttons["voice.accept.0"].waitForExistence(timeout: 5), "an undone change is offered again")
        XCTAssertTrue(waitForLabel(of: scrolledTo(size, upward: true), prefix: "Size, No value"), size.label)
        app.buttons["voice.accept.0"].tap()
        XCTAssertTrue(waitForLabel(of: size, prefix: "Size, M, From You"), size.label)
        app.buttons["voice.done"].tap()
        XCTAssertFalse(app.descendants(matching: .any)["voice.tray"].exists)
    }

    /// "Next" opens the least certain detail and a swipe moves on; touch and hold offers common
    /// values.
    private func correctFast() {
        app.buttons["review.nextToCheck"].tap()
        let brand = app.textFields["review.editor.brand"]
        XCTAssertTrue(brand.waitForExistence(timeout: 5))
        brand.swipeLeft()
        XCTAssertTrue(app.textFields["review.editor.colors"].waitForExistence(timeout: 5))
        app.buttons["review.editor.done"].tap()

        let pattern = scrolledTo(app.buttons["review.field.pattern"])
        pattern.press(forDuration: 1)
        let striped = app.buttons["Striped"]
        XCTAssertTrue(striped.waitForExistence(timeout: 5))
        striped.tap()
        XCTAssertTrue(waitForLabel(of: pattern, prefix: "Pattern, Striped, From You"), pattern.label)
    }

    // MARK: Steps

    private func launch(signedInTo stack: E2EStack, environment: [String: String] = [:]) throws {
        let fixtures = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "Fixtures", withExtension: nil))
        app.launchEnvironment = [
            "LISTORA_FIXTURE_PHOTOS": fixtures.path(percentEncoded: false),
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": stack.token,
            "LISTORA_DEV_ACCESS_EMAIL": stack.email,
        ].merging(environment) { _, new in new }
        app.launch()
        let tab = app.tabBars.buttons["Add"]
        XCTAssertTrue(tab.waitForExistence(timeout: 10))
        tab.tap()
    }

    /// Imports the fixture photos, makes the third one the tag so the phone reads it, and opens
    /// the review, which waits for the upload, the photo processing, and the analysis.
    private func createDraftAndOpenReview() {
        app.buttons["addItem.importPhotos"].tap()
        let tag = app.buttons["photo.tile.2"]
        XCTAssertTrue(tag.waitForExistence(timeout: 15))
        tag.tap()
        let role = app.buttons["photo.role.tag"]
        XCTAssertTrue(role.waitForExistence(timeout: 5))
        role.tap()
        app.buttons["photo.done"].tap()

        let review = app.buttons["draft.review"]
        XCTAssertTrue(review.waitForExistence(timeout: 5))
        review.tap()
        let attention = app.staticTexts["review.section.attention"]
        XCTAssertTrue(attention.waitForExistence(timeout: 120), "the review never appeared")
        // The size the tag doesn't show, then the uncertain brand and color.
        XCTAssertEqual(attention.label, "Check these (3)")
        keepScreenshot("Review")
    }

    /// The uncertain brand (read off the tag) and color lead, highlighted; fixing the color in
    /// place makes it the seller's.
    private func reviewConfidenceFirst() {
        // Each read of `label` queries the app again, and the rows can still be settling just after
        // the review appears, so wait for each label instead of reading it once.
        let brand = app.buttons["review.field.brand"]
        XCTAssertTrue(
            waitForLabel(of: brand, prefix: "Brand, Acme Outfitters, From Tag, Check this: 45% sure"),
            brand.label,
        )
        let colors = app.buttons["review.field.colors"]
        XCTAssertTrue(waitForLabel(of: colors, prefix: "Colors, Blue, From AI, Check this: 50% sure"), colors.label)
        XCTAssertLessThan(brand.frame.minY, colors.frame.minY, "the least certain detail comes first")
        let rnNumber = app.buttons["review.field.rnNumber"]
        XCTAssertTrue(waitForLabel(of: rnNumber, prefix: "RN number, 12345, From Tag"), rnNumber.label)
        let category = app.buttons["review.field.category"]
        XCTAssertTrue(
            waitForLabel(of: category, prefix: "Category, Clothing › Tops › Shirts, From AI"),
            category.label,
        )

        // The size the tag lacks leads the list now, which can push the color under the bottom bar.
        clearOfBottomBar(colors).tap()
        let editor = app.textFields["review.editor.colors"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 8) + "navy")
        app.buttons["review.editor.done"].tap()
        let edited = app.buttons["review.field.colors"]
        XCTAssertTrue(waitForLabel(of: edited, prefix: "Colors, Navy, From You"), edited.label)
    }

    /// "Identify harder" is prominent for the uncertain brand, says what it uses, and keeps the
    /// seller's edit when its details arrive.
    private func identifyHarder() {
        // Back to the top: editing scrolled the review, and a large text size pushes the card off.
        app.buttons["review.field.brand"].swipeDown()
        let identifyHarder = app.buttons["review.identifyHarder"]
        XCTAssertTrue(identifyHarder.exists)
        XCTAssertEqual(
            app.staticTexts["review.premiumQuota"].label,
            "Uses 1 premium identification. 0 used this month.",
        )
        identifyHarder.tap()
        XCTAssertTrue(app.descendants(matching: .any)["review.premiumDone"].waitForExistence(timeout: 60))
        XCTAssertTrue(app.buttons["review.field.colors"].label.hasPrefix("Colors, Navy, From You"))
        XCTAssertEqual(app.staticTexts["review.section.attention"].label, "Check these (2)")
    }

    /// The cost on the in-app keypad, then where it was bought.
    private func enterCost() {
        app.buttons["review.continue"].tap()
        let amount = app.staticTexts["cost.amount"]
        XCTAssertTrue(amount.waitForExistence(timeout: 10))
        app.buttons["keypad.1"].tap()
        app.buttons["keypad.2"].tap()
        XCTAssertEqual(amount.value as? String, "$12")
        keepScreenshot("Cost")
        // Scrolled into view: a field still under the Continue bar would take the bar's tap.
        amount.swipeUp()
        let source = app.textFields["cost.source"]
        source.tap()
        source.typeText("Goodwill\n")
        app.buttons["cost.continue"].tap()
    }

    /// Floors per marketplace and the server's labels, exactly; then the save. Returns the SKU.
    private func choosePriceAndSave() -> String {
        let estimate = app.staticTexts["price.estimateLabel"]
        XCTAssertTrue(estimate.waitForExistence(timeout: 15))
        XCTAssertEqual(estimate.label, "AI estimate - not based on sold listings")
        XCTAssertTrue(app.staticTexts["price.estimateDetail"].label.hasSuffix("Confidence 55%"))
        XCTAssertEqual(app.staticTexts["price.noSoldData"].label, "No sold data available for this item")
        let recommended = app.buttons["price.tier.recommended"]
        XCTAssertTrue(recommended.label.contains("Recommended (AI estimate)"), recommended.label)
        XCTAssertTrue(recommended.label.contains("$26.00"), recommended.label)
        XCTAssertTrue(app.buttons["price.floor.ebay"].label.hasPrefix("eBay, don't sell below $"))
        XCTAssertTrue(app.buttons["price.floor.depop"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["price.research.0"].exists)
        keepScreenshot("Price")

        recommended.tap()
        app.buttons["price.save"].tap()
        let sku = app.staticTexts["saved.sku"]
        XCTAssertTrue(sku.waitForExistence(timeout: 15))
        let text = sku.label.replacingOccurrences(of: "SKU ", with: "")
        XCTAssertNotNil(text.wholeMatch(of: /[A-Z0-9]{1,8}-[0-9]{6,}/), text)
        XCTAssertEqual(app.staticTexts["saved.price"].label, "Price $26.00")
        // The interaction measurement from the first photo to here.
        XCTAssertTrue(app.descendants(matching: .any)["saved.metric"].label.contains(" taps"))
        keepScreenshot("Saved")
        return text
    }

    /// `element` once the review has scrolled it into view, upward or down: its rows load as they
    /// come on screen. It drags near the top of the review, which the voice tray over its bottom
    /// never covers.
    private func scrolledTo(_ element: XCUIElement, upward: Bool = false) -> XCUIElement {
        let scrollView = app.scrollViews["review.scroll"]
        let top = scrollView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08))
        let lower = scrollView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.38))
        // Above the bottom bar, not only hittable: the review scrolls under the bar, and a row
        // there reports hittable while a press on it lands on the bar.
        let barTop = app.buttons["voice.talk"].frame.minY
        for _ in 0 ..< 12 where !(element.exists && element.isHittable && element.frame.maxY < barTop) {
            if upward {
                top.press(forDuration: 0.05, thenDragTo: lower)
            } else {
                lower.press(forDuration: 0.05, thenDragTo: top)
            }
        }
        XCTAssertTrue(element.exists, "never scrolled to \(element)")
        return element
    }

    /// Keeps a screenshot in the result bundle, passing or not, for reviewing the screens.
    private func keepScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func waitForLabel(of element: XCUIElement, prefix: String, timeout: TimeInterval = 5) -> Bool {
        let predicate = NSPredicate(format: "label BEGINSWITH %@", prefix)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }
}

extension ReviewFlowUITests {
    /// A shirt can't be listed without its size, which the tag doesn't show, so Continue waits
    /// for it.
    private func enterSize() {
        XCTAssertEqual(app.staticTexts["review.missing"].label, "Add size to continue.")
        XCTAssertFalse(app.buttons["review.continue"].isEnabled)
        let size = scrolledTo(app.buttons["review.field.sizeLabel"], upward: true)
        size.tap()
        let editor = app.textFields["review.editor.sizeLabel"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.typeText("M")
        app.buttons["review.editor.done"].tap()
        let edited = app.buttons["review.field.sizeLabel"]
        XCTAssertTrue(waitForLabel(of: edited, prefix: "Size, M, From You"), edited.label)
        XCTAssertFalse(app.staticTexts["review.missing"].exists)
    }

    /// Scrolls the review up a little at a time until `element` sits above the bottom bar.
    private func clearOfBottomBar(_ element: XCUIElement) -> XCUIElement {
        let scrollView = app.scrollViews["review.scroll"]
        let start = scrollView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let end = scrollView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
        let barTop = app.descendants(matching: .any)["voice.talk"].frame.minY
        for _ in 0 ..< 6 where element.frame.maxY > barTop - Self.barMargin {
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        return element
    }

    private static let barMargin: CGFloat = 8
}
