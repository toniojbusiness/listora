/// What the item screen hands to "Mark as sold": the item that sold, with what the sale form
/// starts from. The sales feature implements the form; the inventory feature only knows this
/// request, so neither imports the other.
public struct MarkSoldRequest: Hashable, Identifiable, Sendable {
    public let itemID: String
    public let sku: String
    public let title: String?
    /// The sale price the form suggests: the item's list price, in cents.
    public let listPriceCents: Int64?
    /// The marketplaces the item has a listing on (ids such as `ebay`), offered first.
    public let listedOn: [String]

    public var id: String {
        itemID
    }

    public init(itemID: String, sku: String, title: String?, listPriceCents: Int64?, listedOn: [String]) {
        self.itemID = itemID
        self.sku = sku
        self.title = title
        self.listPriceCents = listPriceCents
        self.listedOn = listedOn
    }
}
