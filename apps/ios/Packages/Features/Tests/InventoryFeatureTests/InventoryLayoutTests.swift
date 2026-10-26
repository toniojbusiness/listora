import Testing
@testable import InventoryFeature

struct InventoryLayoutTests {
    @Test
    func `the photo grid is the default and the toolbar button names the other layout`() {
        #expect(InventoryLayout.standard == .grid)
        #expect(InventoryLayout.grid.other == .list)
        #expect(InventoryLayout.list.other == .grid)
        #expect(InventoryLayout.grid.switchTitle == "Show as list")
        #expect(InventoryLayout.list.switchTitle == "Show as grid")
        #expect(InventoryLayout.grid.switchSystemImage != InventoryLayout.list.switchSystemImage)
    }
}
