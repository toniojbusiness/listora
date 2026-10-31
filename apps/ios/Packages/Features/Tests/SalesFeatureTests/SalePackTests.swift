import APIClient
import Foundation
import ListoraAPI
import SwiftUI
import Testing
@testable import SalesFeature

/// A Pack check order as the server sends it, packed or not.
private func packOrder(packed: Bool) throws -> Components.Schemas.PackOrder {
    var object: [String: Any] = [
        "saleId": "sale-1",
        "marketplace": "depop",
        "soldAt": "2026-10-27T12:00:00Z",
        "description": "the black Shaka Wear tee, 2XL",
        "items": [["itemId": "item-1", "sku": "AJ-000184", "description": "black tee"]],
        "labelStatus": ["tone": "neutral", "label": "USPS •••• 8490 (from Depop)"],
        "packStatus": [
            "tone": packed ? "success" : "neutral",
            "label": packed ? "Packed 12 minutes ago (label and sticker matched)" : "Not packed",
        ],
    ]
    if packed {
        object["pack"] = [
            "packedAt": "2026-10-27T12:30:00Z", "trackingNumber": "9400111899223197428490",
            "matchedBy": "sticker", "stickerSku": "AJ-000184", "labelMismatch": false,
        ]
    }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(
        Components.Schemas.PackOrder.self,
        from: JSONSerialization.data(withJSONObject: object),
    )
}

/// What the fake server answers next.
@MainActor
private final class Script {
    var order: Components.Schemas.PackOrder?
    var failing = false
    var packCheckOn = false
}

@MainActor
struct SalePackTests {
    private let toShip: [Components.Schemas.KnownSaleAction] = [.markShipped, .cancel]

    @Test func `with Pack check off, Mark shipped stays the main step`() {
        let steps = SaleSteps(actions: toShip, package: nil)
        #expect(steps.primary == .sale(.markShipped))
        #expect(steps.others == [.sale(.cancel)])
    }

    @Test func `an order to pack is packed first, with Mark shipped below`() throws {
        let steps = try SaleSteps(actions: toShip, package: .loaded(packOrder(packed: false)))
        #expect(steps.primary == .pack)
        #expect(steps.others == [.sale(.markShipped), .sale(.cancel)])
    }

    @Test func `a packed order is shipped next`() throws {
        let steps = try SaleSteps(actions: toShip, package: .loaded(packOrder(packed: true)))
        #expect(steps.primary == .sale(.markShipped))
        #expect(steps.others == [.sale(.cancel)])
    }

    @Test func `a package still loading or that failed to load is still to pack`() {
        #expect(SaleSteps(actions: toShip, package: .loading).primary == .pack)
        #expect(SaleSteps(actions: toShip, package: .failed(message: "Offline")).primary == .pack)
    }

    @Test func `a sale Pack check has no package for keeps Mark shipped`() {
        #expect(SaleSteps(actions: toShip, package: SalePackModel.State.none).primary == .sale(.markShipped))
    }

    @Test func `a shipped sale is never packed, even with Pack check on`() throws {
        let steps = try SaleSteps(actions: [.recordReturn], package: .loaded(packOrder(packed: false)))
        #expect(steps.primary == .sale(.recordReturn))
        #expect(steps.others.isEmpty)
    }

    @Test func `the package loads, packed or not, and none is none`() async throws {
        let unpacked = try packOrder(packed: false)
        let packed = try packOrder(packed: true)
        let script = Script()
        script.order = unpacked
        let model = SalePackModel(saleID: "sale-1") { _ throws(APIFailure) in script.order }
        #expect(model.state == .loading)
        await model.load()
        #expect(model.orderToPack == unpacked)
        #expect(model.packedOrder == nil)
        script.order = packed
        await model.load()
        #expect(model.orderToPack == nil)
        #expect(model.packedOrder?.packStatus.label == "Packed 12 minutes ago (label and sticker matched)")
        script.order = nil
        await model.load()
        #expect(model.state == .none)
    }

    @Test func `a failed load says why, and a failed refresh keeps the package shown`() async throws {
        let packed = try packOrder(packed: true)
        let script = Script()
        script.order = packed
        script.failing = true
        let model = SalePackModel(saleID: "sale-1") { _ throws(APIFailure) in
            if script.failing {
                throw .networkUnavailable
            }
            return script.order
        }
        await model.load()
        guard case .failed = model.state else {
            Issue.record("expected a failure, got \(model.state)")
            return
        }
        script.failing = false
        await model.load()
        #expect(model.packedOrder == packed)
        script.failing = true
        await model.load()
        #expect(model.packedOrder == packed)
    }

    @Test func `the sale's screen has a package only while Pack check is on`() throws {
        let script = Script()
        let entry = SalePackEntry(
            isOn: { script.packCheckOn },
            order: { _ throws(APIFailure) in nil },
            packScreen: { _, _ in AnyView(EmptyView()) },
        )
        let tokens = AccessTokenStore(storage: InMemoryAccessGrantStorage())
        let environment = try SalesEnvironment(
            apiClient: APIClient(baseURL: #require(URL(string: "http://localhost")), accessTokens: tokens),
            accessTokens: tokens,
            salePacking: entry,
        )
        #expect(environment.makePackModel(saleID: "sale-1") == nil)
        script.packCheckOn = true
        #expect(environment.makePackModel(saleID: "sale-1") != nil)
    }
}
