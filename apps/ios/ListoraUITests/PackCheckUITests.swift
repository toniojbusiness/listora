import XCTest

/// Pack check at the packing table (docs/features/pack-check.md), against the local stack: the
/// to-ship list from Sales, a red stop for the other order's label, green and Packed for the
/// right one with a package photo, and the double print: the same label scanned again on the
/// next package is caught, with when and for which order. The scanner "reads" the scanned-label
/// fixtures (`LISTORA_SCANNED_CODES`), since the simulator has no camera.
@MainActor
final class PackCheckUITests: XCTestCase {
    private let app = XCUIApplication()

    /// An order's label as the camera reads its IMpb barcode (a symbology identifier, the
    /// routing code and ZIP, a separator, then the tracking number), and the same label printed
    /// twice, read the plain way. Each seed's labels are its own, so a label one test packs is
    /// never already used in the next, nor in a retry.
    private static func label(_ order: PackOrderSeed) -> String {
        "]C142094107\u{1d}\(order.trackingNumber)"
    }

    private static func plainLabel(_ order: PackOrderSeed, zip: String = "94107") -> String {
        "420\(zip)\(order.trackingNumber)"
    }

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
            "LISTORA_SCANNED_CODES": [Self.plainLabel(dress, zip: "90012"), Self.label(tee), Self.plainLabel(tee)]
                .joined(separator: "|"),
        ]
        app.launchQuietly()
        try packTheTeeAfterStoppingTheDressLabel(tee)
        try catchTheSecondPrint(on: dress)
    }

    /// How the label and the stickers are printed: "How Pack check works" the first time Pack
    /// orders opens; under each order its stickers, and its label with them in one job (asking
    /// first before the same label again), or the order's page on the marketplace where Listora
    /// can't print its label; and on the item screen, "Print sticker" up top while Pack check is
    /// on. Scripted printing stands in for the marketplace's label and the print sheet.
    func testTheLabelAndItsStickersPrintTogetherAndASecondPrintAsksFirst() async throws {
        let stack = try E2EStack.fromEnvironment()
        let orders = try await stack.seedPackOrders()
        let tee = try XCTUnwrap(orders.first)
        let dress = try XCTUnwrap(orders.last)
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": stack.token,
            "LISTORA_DEV_ACCESS_EMAIL": stack.email,
            "LISTORA_SCRIPTED_PRINTING": "1",
        ]
        app.launchQuietly()
        app.tabRail.buttons["Sales"].tap()
        let packOrders = app.buttons["sales.packOrders"]
        XCTAssertTrue(packOrders.waitForExistence(timeout: 15), "no Pack orders entry")
        packOrders.tap()

        // The first time: how it works.
        XCTAssertTrue(app.descendants(matching: .any)["packCheck.explainer"].waitForExistence(timeout: 10))
        keepScreenshot("Pack check - how it works")
        app.buttons["packCheck.explainer.done"].tap()

        // Each order: its sticker, and the tee's label with its sticker; the dress's label opens on eBay.
        XCTAssertTrue(app.buttons["pack.printStickers.\(tee.sku)"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["pack.printStickers.\(dress.sku)"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["pack.openLabel.\(dress.sku)"].exists)
        keepScreenshot("Pack check - print actions")
        app.buttons["pack.printLabel.\(tee.sku)"].tap()
        let print = app.buttons["labelPrint.print"]
        XCTAssertTrue(print.waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["labelPrint.contents"].label.contains(tee.sku))
        print.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["labelPrint.printed"].waitForExistence(timeout: 15),
            "not printed",
        )
        app.buttons["labelPrint.done"].tap()

        // The same label again asks first.
        app.buttons["pack.printLabel.\(tee.sku)"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["labelPrint.printedBefore"].waitForExistence(timeout: 10))
        app.buttons["labelPrint.print"].tap()
        // The system's dialog nests its button in another of the same identifier.
        let again = app.buttons["labelPrint.again"].firstMatch
        XCTAssertTrue(again.waitForExistence(timeout: 5), "no question before the second print")
        keepScreenshot("Pack check - print again?")
        again.tap()
        XCTAssertTrue(app.descendants(matching: .any)["labelPrint.printed"].waitForExistence(timeout: 15))
        app.buttons["labelPrint.done"].tap()

        // The item screen: Print sticker without scrolling, while Pack check is on.
        app.tabRail.buttons["Inventory"].tap()
        let row = app.buttons["inventory.row.\(tee.sku)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        let sticker = app.buttons["item.printSticker"]
        XCTAssertTrue(sticker.waitForExistence(timeout: 15))
        XCTAssertTrue(sticker.isHittable, "Print sticker is off screen")
        keepScreenshot("Pack check - item sticker")
    }

    /// A sale still to ship packs from its own screen: "Pack this order" first, Mark shipped
    /// below; the same scan and its stickers' print; and once packed, the sale says when and how,
    /// with Mark shipped its next step.
    func testASaleToShipPacksFromItsOwnScreen() async throws {
        let stack = try E2EStack.fromEnvironment()
        let orders = try await stack.seedPackOrders()
        let tee = try XCTUnwrap(orders.first)
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": stack.token,
            "LISTORA_DEV_ACCESS_EMAIL": stack.email,
            "LISTORA_SCANNED_CODES": Self.label(tee),
            "LISTORA_SCRIPTED_PRINTING": "1",
        ]
        app.launchQuietly()
        app.tabRail.buttons["Sales"].tap()
        let row = app.buttons["sales.row.\(tee.sku)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "no sale for the tee")
        row.tap()

        let pack = app.buttons["sale.action.pack"]
        XCTAssertTrue(pack.waitForExistence(timeout: 15), "no Pack this order")
        XCTAssertTrue(app.buttons["sale.action.markShipped"].exists, "no Mark shipped below it")
        keepScreenshot("Sale - pack this order")
        pack.tap()

        // The same flow as Pack orders, for this order: its label and stickers print from it.
        XCTAssertTrue(app.buttons["pack.printLabel.\(tee.sku)"].waitForExistence(timeout: 10))
        keepScreenshot("Sale - packing")
        scanLabel(app.buttons["pack.scanLabel"])
        XCTAssertTrue(app.descendants(matching: .any)["pack.verdict.match"].waitForExistence(timeout: 10))
        app.buttons["pack.packed"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["pack.packedBanner"].waitForExistence(timeout: 10))
        app.buttons["pack.next"].tap()
        app.buttons["pack.close"].tap()

        // Packed: when and how, and Mark shipped is next.
        let status = app.descendants(matching: .any)["sale.package.status"]
        XCTAssertTrue(status.waitForExistence(timeout: 15), "no packed state")
        XCTAssertTrue(status.label.contains("Packed just now (label matched)"), status.label)
        XCTAssertFalse(app.buttons["sale.action.pack"].exists)
        XCTAssertTrue(app.buttons["sale.action.markShipped"].exists)
        keepScreenshot("Sale - packed")

        // Open package shows it in Pack check, on its package; unpacked, it is to pack again.
        app.buttons["sale.package.open"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["pack.packedBanner"].waitForExistence(timeout: 10))
        app.buttons["pack.unpack"].tap()
        XCTAssertTrue(app.buttons["pack.scanLabel"].waitForExistence(timeout: 10), "not unpacked")
        app.buttons["pack.end"].tap()
        let close = app.buttons["pack.close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        close.tap()
        XCTAssertTrue(app.buttons["sale.action.pack"].waitForExistence(timeout: 15), "not to pack again")
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
        // The first opening explains how Pack check works.
        let gotIt = app.buttons["packCheck.explainer.done"]
        XCTAssertTrue(gotIt.waitForExistence(timeout: 10), "no How Pack check works")
        gotIt.tap()

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
