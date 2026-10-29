import Foundation
import Testing
@testable import InventoryFeature

/// The Inventory list's order: sent to the server, remembered across launches, never a filter.
@MainActor
@Suite("Inventory sort")
struct InventorySortTests {
    @Test
    func `remembers the order, sends it with the filters, and keeps it when they clear`() async throws {
        let defaults = try #require(UserDefaults(suiteName: "InventorySortTests-\(UUID().uuidString)"))
        let service = FakeInventoryService()
        let model = InventoryListModel(service: service, defaults: defaults)
        #expect(model.query.sort == .addedNewest)
        model.query.sort = .priceHigh
        #expect(!model.isFiltered, "an order is not a filter")
        model.query.brand = "Levi's"
        await model.load()
        #expect(service.queries.last?.sort == .priceHigh)
        #expect(service.queries.last?.brand == "Levi's")
        model.clearFilters()
        #expect(model.query == InventoryQuery(sort: .priceHigh))
        #expect(!model.isFiltered)

        // The next launch opens in the same order; an order this build doesn't know falls back.
        #expect(InventoryListModel(service: service, defaults: defaults).query.sort == .priceHigh)
        defaults.set("by_vibes", forKey: ItemSort.storageKey)
        #expect(InventoryListModel(service: service, defaults: defaults).query.sort == .addedNewest)
        InventoryEnvironment.resetLocalData(defaults: defaults)
        #expect(defaults.string(forKey: ItemSort.storageKey) == nil)
    }
}
