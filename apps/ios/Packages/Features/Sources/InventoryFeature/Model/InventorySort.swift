import ListoraAPI

typealias ItemSort = Components.Schemas.ItemSort

/// The orders of the Inventory list, which the server sorts (`listItems`' `sort`, so a sort
/// covers every item, not only the pages loaded). The seller's last choice is kept in
/// `UserDefaults` under ``storageKey``.
extension ItemSort {
    static let storageKey = "com.listora.inventory-sort"
    /// Before the seller picks one: newest added first.
    static let standard = ItemSort.addedNewest

    /// The order's name, in the sort menu and on its pill.
    var title: String {
        switch self {
        case .addedNewest: "Recently added"
        case .listedNewest: "Date listed: newest"
        case .listedOldest: "Date listed: oldest"
        case .priceHigh: "Price: high to low"
        case .priceLow: "Price: low to high"
        case .staleFirst: "Stale first"
        case .profitHigh: "Profit: high to low"
        case .nameAz: "Name: A to Z"
        }
    }
}
