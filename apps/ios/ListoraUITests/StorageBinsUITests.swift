import XCTest

/// Storage bins (docs/features/storage-bins.md) against the local stack: on an item's screen, Put
/// in a bin scans a bin sticker no bin has yet, makes that bin, and puts the item in it; the item
/// then shows its bin, and once the item sells,
/// its sale says "Find it: bin ...". The scanner "reads" the bin sticker (`LISTORA_SCANNED_CODES`),
/// since the simulator has no camera.
@MainActor
final class StorageBinsUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testScanABinStickerMakeTheBinPutTheItemInAndFindItOnTheSale() async throws {
        let stack = try E2EStack.fromEnvironment()
        let item = try await stack.seedReadyItem()
        // Its own code, so a retry or another test's bins never already have it.
        let code = "UI-\(Int.random(in: 1000 ... 9999))"
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": stack.apiURL.absoluteString,
            "LISTORA_DEV_ACCESS_TOKEN": stack.token,
            "LISTORA_DEV_ACCESS_EMAIL": stack.email,
            "LISTORA_SCANNED_CODES": "LISTORA-BIN:\(code)",
        ]
        app.launchQuietly()
        let inventory = app.tabRail.buttons["Inventory"]
        XCTAssertTrue(inventory.waitForExistence(timeout: 10))
        inventory.tap()
        let row = app.buttons["inventory.row.\(item.sku)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "the seeded item is not in the inventory")
        row.tap()

        // The item is in no bin: Put in a bin, then scan the bin's sticker.
        let bin = app.buttons["item.storage"]
        XCTAssertTrue(bin.waitForExistence(timeout: 15))
        for _ in 0 ..< 6 where !bin.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(bin.label.contains("none"), bin.label)
        bin.tap()
        let scan = app.buttons["binPicker.scan"]
        XCTAssertTrue(scan.waitForExistence(timeout: 15))
        keepScreenshot("Put in a bin")
        scan.tap()
        let scanner = app.buttons["scanner.scan"]
        XCTAssertTrue(scanner.waitForExistence(timeout: 10))
        scanner.tap()

        // No bin has the code yet: make it, and the item goes in it.
        let make = app.buttons["binPicker.makeScanned"]
        XCTAssertTrue(make.waitForExistence(timeout: 15), "the scanned code was not offered as a new bin")
        keepScreenshot("A bin sticker no bin has yet")
        make.tap()
        let codeField = app.textFields["binForm.code"]
        XCTAssertTrue(codeField.waitForExistence(timeout: 10))
        XCTAssertEqual(codeField.value as? String, code)
        app.buttons["binForm.save"].tap()
        XCTAssertTrue(waitForLabel(of: bin, code, timeout: 20), bin.label)
        keepScreenshot("In its bin")

        // Once it sells, its sale says where to find it.
        try await stack.recordSale(itemID: item.id, marketplace: "depop", priceCents: 2500)
        app.tabRail.buttons["Sales"].tap()
        let saleRow = app.buttons["sales.row.\(item.sku)"]
        XCTAssertTrue(saleRow.waitForExistence(timeout: 20), "the sale is not in the Sales tab")
        saleRow.tap()
        let findIt = app.descendants(matching: .any)["sale.findIt"]
        XCTAssertTrue(findIt.waitForExistence(timeout: 15), "the sale does not say where to find the item")
        XCTAssertEqual(findIt.label, "Find it: bin \(code)")
        keepScreenshot("Find it on the sale")
    }

    private func waitForLabel(of element: XCUIElement, _ text: String, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "label CONTAINS %@", text)
        return XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: element)], timeout: timeout)
            == .completed
    }

    /// Keeps a screenshot in the result bundle, passing or not, for reviewing the screens.
    private func keepScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
