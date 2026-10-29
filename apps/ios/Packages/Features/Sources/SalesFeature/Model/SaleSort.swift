import ListoraAPI

typealias SaleSort = Components.Schemas.SaleSort

/// The orders of the sales list, which the server sorts (`listSales`' `sort`, so a sort covers
/// every sale, not only the pages loaded). The seller's last choice is kept in `UserDefaults`
/// under ``storageKey``.
extension SaleSort {
    static let storageKey = "com.listora.sales-sort"
    /// Before the seller picks one: newest sold first.
    static let standard = SaleSort.soldNewest

    /// The order's name, in the sort menu and on its pill.
    var title: String {
        switch self {
        case .soldNewest: "Recently sold"
        case .soldOldest: "Date sold: oldest"
        case .priceHigh: "Price: high to low"
        case .priceLow: "Price: low to high"
        case .profitHigh: "Profit: high to low"
        }
    }
}
