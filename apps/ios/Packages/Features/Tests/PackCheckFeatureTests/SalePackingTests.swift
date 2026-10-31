import APIClient
import Testing
@testable import PackCheckFeature

/// Packing one order from its sale's screen (docs/features/pack-check.md, "On the sale's screen").
@MainActor
struct SalePackingTests {
    @Test func `a packed order opens on its package, to unpack or add its photo`() async throws {
        let service = FakePackService()
        let model = try PackSessionModel(orders: [order("sale-a", title: "tee", packed: true)], service: service)
        #expect(model.stage == .packed)
        await model.unpack()
        #expect(model.stage == .scanLabel)
        #expect(model.current?.pack == nil)
    }

    @Test func `one sale's order comes from the server, and none for a sale Pack check doesn't have`() async throws {
        let service = FakePackService()
        let environment = PackCheckEnvironment(service: service)
        #expect(try await environment.saleOrder(saleID: "sale-a")?.pack == nil)
        #expect(try await environment.saleOrder(saleID: "sale-z") == nil)
        let first = try #require(await environment.saleOrder(saleID: "sale-a"))
        let model = PackSessionModel(orders: [first], service: service)
        await model.scannedLabel(DoublePrint.labelA)
        await model.pack()
        #expect(try await environment.saleOrder(saleID: "sale-a")?.pack != nil)
    }

    @Test func `a label printed in the session shows on its order`() throws {
        let model = try PackSessionModel(orders: [order("sale-a", title: "tee")], service: FakePackService())
        try model.replaced(labeledOrder("sale-a", printed: "Label printed just now"))
        #expect(model.current?.label?.printed?.label == "Label printed just now")
        #expect(model.stage == .scanLabel)
    }
}

extension FakePackService {
    /// Sale A, packed once its label went on; anything else is not Pack check's.
    func saleOrder(saleID: String) async throws(APIFailure) -> PackOrder? {
        guard saleID == "sale-a" else { return nil }
        do {
            let packed = packedLabels["A"] == saleID
            return try PackCheckFeatureTests.order(saleID, title: "black Shaka Wear tee, 2XL", packed: packed)
        } catch {
            throw APIFailure(error)
        }
    }
}
