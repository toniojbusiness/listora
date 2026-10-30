import APIClient
import Core
import Foundation
import ListoraAPI
import Testing
import UIKit
@testable import PackCheckFeature

/// The scanned labels of the shared fixtures (packages/pack-check/src/test-fixtures.ts): order A's
/// label printed twice, read two ways, and order B's.
enum DoublePrint {
    static let labelA = "]C142094107\u{1d}9400111899223197428490"
    static let labelACopy = "420941079400111899223197428490"
    static let labelB = "420900129400111899223197420001"
}

/// Decodes a contract type from the JSON object the server would send.
func decode<T: Decodable>(_: T.Type, _ object: [String: Any]) throws -> T {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(T.self, from: JSONSerialization.data(withJSONObject: object))
}

func order(_ saleID: String, title: String, packed: Bool = false) throws -> PackOrder {
    var object: [String: Any] = [
        "saleId": saleID,
        "marketplace": "depop",
        "soldAt": "2026-10-27T12:00:00Z",
        "description": "the \(title)",
        "buyerFirstName": "Sarah",
        "items": [["itemId": "item-\(saleID)", "sku": "AJ-000184", "description": title, "title": title]],
        "labelStatus": ["tone": "neutral", "label": "USPS •••• 8490 (from Depop)"],
        "packStatus": [
            "tone": packed ? "success" : "neutral",
            "label": packed ? "Packed just now (label matched)" : "Not packed",
        ],
    ]
    if packed {
        object["pack"] = [
            "packedAt": "2026-10-27T12:30:00Z", "trackingNumber": "9400111899223197428490",
            "matchedBy": "label", "labelMismatch": false,
        ]
    }
    return try decode(PackOrder.self, object)
}

func scan(_ verdict: String, tone: String, headline: String, canPack: Bool = false, canPhotoCheck: Bool = false) throws
    -> PackScan
{
    try decode(PackScan.self, [
        "verdict": verdict, "tone": tone, "headline": headline, "detail": "Detail.",
        "canPack": canPack, "canPhotoCheck": canPhotoCheck,
    ])
}

/// A fake server: orders A and B, each label packed once, as the server's rules say.
actor FakePackService: PackCheckService {
    var enabled = false
    var packedLabels: [String: String] = [:]
    struct PackCall: Equatable {
        let saleID: String
        let label: String
        let sticker: String?
        let photoCheck: Bool
        let key: String
    }

    var packCalls: [PackCall] = []
    var refreshes = 0
    var failSave = false
    var photos: [String] = []

    func setFailSave(_ value: Bool) {
        failSave = value
    }

    func isEnabled() async throws(APIFailure) -> Bool {
        enabled
    }

    func setEnabled(_ value: Bool) async throws(APIFailure) -> Bool {
        if failSave {
            throw .networkUnavailable
        }
        enabled = value
        return value
    }

    func orders() async throws(APIFailure) -> [PackOrder] {
        do {
            return try [
                order("sale-a", title: "black Shaka Wear tee, 2XL"),
                order("sale-b", title: "Free People dress"),
            ]
        } catch {
            throw APIFailure(error)
        }
    }

    func refreshLabels() async throws(APIFailure) -> Int {
        refreshes += 1
        return 1
    }

    /// Order A's label is A's; B's is B's; a label packed once is "already used".
    func check(label: String?, sticker _: String?, saleID: String?) async throws(APIFailure) -> PackScan {
        let tracking = label.map { $0.hasSuffix("8490") ? "A" : "B" }
        do {
            if let tracking, let packedOn = packedLabels[tracking], packedOn != saleID {
                return try scan("already_packed", tone: "failed", headline: "This label was already used.")
            }
            let own = (tracking == "A" && saleID == "sale-a") || (tracking == "B" && saleID == "sale-b")
            return own
                ? try scan("match", tone: "success", headline: "This label is for this order.", canPack: true)
                : try scan("wrong_order", tone: "failed", headline: "This label is for another order.")
        } catch {
            throw APIFailure(error)
        }
    }

    func pack(
        saleID: String,
        label: String,
        sticker: String?,
        photoCheck: Bool,
        idempotencyKey: String,
    ) async throws(APIFailure) -> PackOrder {
        packCalls.append(PackCall(
            saleID: saleID,
            label: label,
            sticker: sticker,
            photoCheck: photoCheck,
            key: idempotencyKey,
        ))
        packedLabels[label.hasSuffix("8490") ? "A" : "B"] = saleID
        do {
            return try order(
                saleID,
                title: saleID == "sale-a" ? "black Shaka Wear tee, 2XL" : "Free People dress",
                packed: true,
            )
        } catch {
            throw APIFailure(error)
        }
    }

    func unpack(saleID: String) async throws(APIFailure) -> PackOrder {
        packedLabels = packedLabels.filter { $0.value != saleID }
        do { return try order(saleID, title: "unpacked") } catch { throw APIFailure(error) }
    }

    func addPhoto(saleID: String, jpeg _: Data, keys _: PackPhotoKeys) async throws(APIFailure) -> PackOrder {
        photos.append(saleID)
        do { return try order(saleID, title: "with photo", packed: true) } catch { throw APIFailure(error) }
    }

    func removePhoto(saleID: String) async throws(APIFailure) -> PackOrder {
        do { return try order(saleID, title: "without photo", packed: true) } catch { throw APIFailure(error) }
    }

    /// The label prints recorded, by idempotency key: a retry with the same key counts once.
    var labelPrints: [String: String] = [:]
    var failRecord = false

    func setFailRecord(_ value: Bool) {
        failRecord = value
    }

    func recordLabelPrint(
        saleID: String,
        trackingNumber: String,
        idempotencyKey: String,
    ) async throws(APIFailure) -> PackOrder {
        if failRecord {
            throw .networkUnavailable
        }
        labelPrints[idempotencyKey] = trackingNumber
        do {
            return try labeledOrder(saleID, printed: "Label printed just now")
        } catch {
            throw APIFailure(error)
        }
    }
}

/// An order whose label's file Listora can print, printed before when `printed` says so.
func labeledOrder(_ saleID: String, printed: String? = nil, file: Bool = true) throws -> PackOrder {
    var label: [String: Any] = [
        "trackingNumber": "9400111899223197428490", "carrier": "usps", "source": "marketplace",
    ]
    if file {
        label["fileUrl"] = "https://webapi.depop.com/presentation/api/v1/receipts/412/label/"
    }
    if let printed {
        label["printed"] = ["printedAt": "2026-10-27T12:30:00Z", "count": 1, "label": printed]
    }
    return try decode(PackOrder.self, [
        "saleId": saleID,
        "marketplace": "depop",
        "soldAt": "2026-10-27T12:00:00Z",
        "description": "the black Shaka Wear tee, 2XL",
        "items": [
            ["itemId": "item-1", "sku": "AJ-000184", "description": "black tee", "title": "Shaka Wear tee",
             "location": ["code": "B-12"]],
            ["itemId": "item-2", "sku": "AJ-000185", "description": "green dress"],
        ],
        "label": label,
        "labelStatus": ["tone": "neutral", "label": "USPS •••• 8490 (from Depop)"],
        "labelPageUrl": "https://www.depop.com/sellinghub/sold-items/",
        "packStatus": ["tone": "neutral", "label": "Not packed"],
    ])
}

@MainActor
struct PackSessionModelTests {
    @Test func `the order's own label is green and packs`() async throws {
        let service = FakePackService()
        let model = try PackSessionModel(orders: [order("sale-a", title: "tee")], service: service)
        await model.scannedLabel(DoublePrint.labelA)
        guard case let .verdict(result, _) = model.stage else { Issue.record("no verdict"); return }
        #expect(result.verdict.value1 == .match)
        #expect(result.canPack)
        await model.pack()
        #expect(model.stage == .packed)
        #expect(model.current?.pack != nil)
        #expect(await service.packCalls.map(\.saleID) == ["sale-a"])
    }

    @Test func `another order's label is a red stop and never packs`() async throws {
        let service = FakePackService()
        let model = try PackSessionModel(orders: [order("sale-a", title: "tee")], service: service)
        await model.scannedLabel(DoublePrint.labelB)
        guard case let .verdict(result, _) = model.stage else { Issue.record("no verdict"); return }
        #expect(result.verdict.value1 == .wrongOrder)
        #expect(!result.canPack)
        await model.pack()
        #expect(await service.packCalls.isEmpty)
    }

    @Test func `a double-printed label is caught on the second package`() async throws {
        let service = FakePackService()
        let model = try PackSessionModel(
            orders: [order("sale-a", title: "tee"), order("sale-b", title: "dress")],
            service: service,
        )
        await model.scannedLabel(DoublePrint.labelA)
        await model.pack()
        model.next()
        #expect(model.current?.saleId == "sale-b")
        #expect(model.progress == "Order 2 of 2")
        await model.scannedLabel(DoublePrint.labelACopy)
        guard case let .verdict(result, _) = model.stage else { Issue.record("no verdict"); return }
        #expect(result.verdict.value1 == .alreadyPacked)
        #expect(!result.canPack)
        // The right label still packs it.
        model.scanAgain()
        await model.scannedLabel(DoublePrint.labelB)
        await model.pack()
        #expect(await service.packCalls.map(\.saleID) == ["sale-a", "sale-b"])
    }

    @Test func `the end of a session names the orders still not packed`() async throws {
        let service = FakePackService()
        let model = try PackSessionModel(
            orders: [order("sale-a", title: "tee"), order("sale-b", title: "dress")],
            service: service,
        )
        await model.scannedLabel(DoublePrint.labelA)
        await model.pack()
        model.next()
        model.skip()
        #expect(model.stage == .finished)
        #expect(model.unpacked.map(\.saleId) == ["sale-b"])
    }

    @Test func `a retried pack keeps its idempotency key`() async throws {
        let service = FakePackService()
        let model = try PackSessionModel(orders: [order("sale-a", title: "tee")], service: service)
        await model.scannedLabel(DoublePrint.labelA)
        await model.pack()
        await model.unpack()
        await model.scannedLabel(DoublePrint.labelA)
        await model.pack()
        let keys = await service.packCalls.map(\.key)
        #expect(keys.count == 2)
        #expect(keys[0] == keys[1])
    }

    @Test func `the sticker scanned with the label goes with the pack`() async throws {
        let service = FakePackService()
        let model = try PackSessionModel(orders: [order("sale-a", title: "tee")], service: service)
        await model.scannedLabel(DoublePrint.labelA)
        await model.scannedSticker("LISTORA:AJ-000184")
        await model.pack()
        #expect(await service.packCalls.first?.sticker == "LISTORA:AJ-000184")
    }

    @Test func `the package photo is kept with the order`() async throws {
        let service = FakePackService()
        let model = try PackSessionModel(orders: [order("sale-a", title: "tee")], service: service)
        let image = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 10)).image { _ in }
        await model.savePhoto(image)
        #expect(await service.photos == ["sale-a"])
        #expect(model.photoError == nil)
    }
}

@MainActor
struct PackOrdersModelTests {
    @Test func `opening the list asks for the missing labels and runs the phone's reads`() async {
        let service = FakePackService()
        var ran = 0
        let model = PackOrdersModel(service: service, runPhoneWork: { ran += 1 }, pause: { _ in })
        await model.refresh()
        #expect(model.phase == .loaded)
        #expect(model.unpacked.count == 2)
        #expect(await service.refreshes == 1)
        #expect(ran == 1)
        #expect(model.readingLabels == 0)
    }

    @Test func `signed out it never calls the server`() async {
        let service = FakePackService()
        let model = PackOrdersModel(service: service, isSignedIn: { false })
        await model.refresh()
        #expect(model.phase == .signedOut)
        #expect(await service.refreshes == 0)
    }
}

@MainActor
struct PackCheckSettingsModelTests {
    @Test func `it is off until turned on, and remembers it`() async throws {
        let defaults = try #require(UserDefaults(suiteName: "pack-settings-\(UUID().uuidString)"))
        let service = FakePackService()
        var ran = 0
        let model = PackCheckSettingsModel(service: service, defaults: defaults, onEnabled: { ran += 1 })
        await model.load()
        #expect(!model.isEnabled)
        await model.setEnabled(true)
        #expect(model.isEnabled)
        #expect(ran == 1)
        #expect(PackCheckSettingsModel(service: service, defaults: defaults).isEnabled)
    }

    @Test func `a failed save stays off and says why`() async throws {
        let defaults = try #require(UserDefaults(suiteName: "pack-settings-\(UUID().uuidString)"))
        let service = FakePackService()
        await service.setFailSave(true)
        let model = PackCheckSettingsModel(service: service, defaults: defaults)
        await model.setEnabled(true)
        #expect(!model.isEnabled)
        #expect(model.saveError != nil)
    }
}

@MainActor
struct StickerTests {
    @Test func `a sticker's QR code names its SKU`() throws {
        let request = StickerRequest(sku: "AJ-000184", title: "Shaka Wear tee", locationCode: "B-12")
        #expect(request.code == "LISTORA:AJ-000184")
        let image = try #require(StickerSheet.qrImage(request.code, side: 72))
        let detector = try #require(CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: nil))
        let features = try detector.features(in: #require(CIImage(image: image)))
        #expect((features.first as? CIQRCodeFeature)?.messageString == "LISTORA:AJ-000184")
    }

    @Test(arguments: StickerFormat.allCases)
    func `every format prints a PDF`(format: StickerFormat) {
        let request = StickerRequest(sku: "AJ-000184", title: "Shaka Wear tee", locationCode: "B-12")
        let pdf = StickerSheet.pdf(Array(repeating: request, count: 31), format: format)
        #expect(pdf.starts(with: Data("%PDF".utf8)))
    }

    @Test func `a packing slip prints`() {
        let slip = PackingSlip(
            buyerFirstName: "Sarah",
            orderNumber: "m61572195470",
            marketplace: "Mercari",
            items: [.init(title: "Nike sports bra", sku: "AJ-000001", photo: nil)],
        )
        #expect(slip.pdf(format: .label4x6).starts(with: Data("%PDF".utf8)))
    }

    @Test func `the package photo leaves without its metadata, at most 1600 pixels`() throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 2400, height: 1200)).image { _ in }
        let jpeg = try #require(PackPhoto.jpeg(from: image))
        let source = try #require(CGImageSourceCreateWithData(jpeg as CFData, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        #expect(properties[kCGImagePropertyGPSDictionary] == nil)
        #expect((properties[kCGImagePropertyPixelWidth] as? Int) == 1600)
    }
}
