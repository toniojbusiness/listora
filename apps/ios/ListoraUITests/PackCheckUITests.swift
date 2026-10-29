import XCTest

/// Pack check at the packing table (docs/features/pack-check.md), against the local stack: the
/// to-ship list from Sales, a red stop for the other order's label, green and Packed for the
/// right one with a package photo, and the double print: the same label scanned again on the
/// next package is caught, with when and for which order. The scanner "reads" the scanned-label
/// fixtures (`LISTORA_SCANNED_CODES`), since the simulator has no camera.
@MainActor
final class PackCheckUITests: XCTestCase {
    private let app = XCUIApplication()

    /// Order A's label as the camera reads its IMpb barcode, order B's, and order A's label
    /// printed twice, read the plain way.
    private static let labelA = "]C142094107\u{1d}9400111899223197428490"
    private static let labelB = "420900129400111899223197420001"
    private static let labelACopy = "420941079400111899223197428490"

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testTheWrongLabelStopsTheRightOnePacksAndASecondPrintIsCaught() async throws {
        let stack = try E2EStack.fromEnvironment()
        let orders = try await stack.seedPackOrders()
        let tee = try XCTUnwrap(orders.first)
        let dress = try XCTUnwrap(orders.last)
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": stack.token,
            "LISTORA_DEV_ACCESS_EMAIL": stack.email,
            "LISTORA_SCANNED_CODES": [Self.labelB, Self.labelA, Self.labelACopy].joined(separator: "|"),
        ]
        app.launchQuietly()
        try packTheTeeAfterStoppingTheDressLabel(tee)
        try catchTheSecondPrint(on: dress)
    }

    /// Sales > Pack orders, then the tee: the dress's label is a red stop, its own label packs.
    private func packTheTeeAfterStoppingTheDressLabel(_ tee: PackOrderSeed) throws {
        // Sales shows the way in while Pack check is on.
        let sales = app.tabRail.buttons["Sales"]
        XCTAssertTrue(sales.waitForExistence(timeout: 10))
        sales.tap()
        let packOrders = app.buttons["sales.packOrders"]
        XCTAssertTrue(packOrders.waitForExistence(timeout: 15), "no Pack orders entry")
        packOrders.tap()

        // Order A: the tee. Its card names the buyer and the label read from the marketplace.
        let teeCard = app.buttons["pack.order.\(tee.sku)"]
        XCTAssertTrue(teeCard.waitForExistence(timeout: 15), "no card for the tee")
        XCTAssertTrue(teeCard.label.contains("For Sarah"), teeCard.label)
        XCTAssertTrue(teeCard.label.contains("8490"), teeCard.label)
        teeCard.tap()

        // The dress's label on the tee's package: a red stop naming the dress.
        scanLabel(app.buttons["pack.scanLabel"])
        let stop = app.descendants(matching: .any)["pack.verdict.wrong_order"]
        XCTAssertTrue(stop.waitForExistence(timeout: 10), "no red stop")
        XCTAssertTrue(stop.label.contains("This label is for the green Free People dress, S."), stop.label)
        XCTAssertTrue(stop.label.contains("Do not use it on this package."), stop.label)
        XCTAssertFalse(app.buttons["pack.packed"].exists)
        keepScreenshot("Pack check - wrong label")

        // The tee's own label: green, then Packed, then the package photo.
        scanLabel(app.buttons["pack.scanAgain"])
        let match = app.descendants(matching: .any)["pack.verdict.match"]
        XCTAssertTrue(match.waitForExistence(timeout: 10), "no match")
        XCTAssertTrue(match.label.contains("This label is for the black Shaka Wear tee, 2XL."), match.label)
        keepScreenshot("Pack check - right label")
        app.buttons["pack.packed"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["pack.packedBanner"].waitForExistence(timeout: 10))
        app.buttons["pack.addPhoto"].tap()
        XCTAssertTrue(app.staticTexts["Package photo kept for a claim"].waitForExistence(timeout: 15))
        app.buttons["pack.next"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["pack.summary.done"].waitForExistence(timeout: 5))
        app.buttons["pack.close"].tap()
    }

    /// The tee's label printed twice is caught on the dress's package, and ending the session
    /// names the dress, still not packed.
    private func catchTheSecondPrint(on dress: PackOrderSeed) throws {
        // Order B: the dress. The tee's label printed twice is caught on its package.
        let dressCard = app.buttons["pack.order.\(dress.sku)"]
        XCTAssertTrue(dressCard.waitForExistence(timeout: 10))
        dressCard.tap()
        scanLabel(app.buttons["pack.scanLabel"])
        let used = app.descendants(matching: .any)["pack.verdict.already_packed"]
        XCTAssertTrue(used.waitForExistence(timeout: 10), "the second print was not caught")
        XCTAssertTrue(used.label.contains("This label was already used."), used.label)
        XCTAssertTrue(used.label.contains("black Shaka Wear tee, 2XL"), used.label)
        XCTAssertTrue(used.label.contains("printed it twice"), used.label)
        keepScreenshot("Pack check - double print")

        // Ending the session names the order still not packed.
        app.buttons["pack.end"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["pack.summary.unpacked"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["1 order is not packed"].exists)
    }

    /// Opens the scanner and "scans" the next scripted code.
    private func scanLabel(_ button: XCUIElement) {
        XCTAssertTrue(button.waitForExistence(timeout: 10))
        button.tap()
        let scan = app.buttons["scanner.scan"]
        XCTAssertTrue(scan.waitForExistence(timeout: 5), "no scanner")
        scan.tap()
    }

    private func keepScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
