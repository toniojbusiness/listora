/// How Inventory shows the items: a grid of large photos (the default, since sellers find an item
/// by its photo) or a list of rows with more of each item's status. The seller's last choice is
/// kept in `UserDefaults` under ``storageKey``.
enum InventoryLayout: String, CaseIterable, Sendable {
    case grid
    case list

    static let storageKey = "com.listora.inventory-layout"
    /// Before the seller picks one.
    static let standard = InventoryLayout.grid

    /// The layout the toolbar button switches to.
    var other: InventoryLayout {
        switch self {
        case .grid: .list
        case .list: .grid
        }
    }

    /// The toolbar button's label, which names the layout it switches to.
    var switchTitle: String {
        switch other {
        case .grid: "Show as grid"
        case .list: "Show as list"
        }
    }

    var switchSystemImage: String {
        switch other {
        case .grid: "square.grid.2x2"
        case .list: "list.bullet"
        }
    }
}
