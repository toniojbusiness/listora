/// What the Add Item flow hands to review once a draft's photos are on the server: the server
/// item to analyze, review, price, and save. The review feature implements the screens; the Add
/// Item feature only knows this request, so neither imports the other.
public struct ItemReviewRequest: Hashable, Sendable {
    /// The ``InteractionMeter`` session the review continues (the draft's id).
    public let sessionID: String
    /// The server item (`Item.id`).
    public let itemID: String
    /// The item's SKU, when the draft already knows it.
    public let sku: String?

    public init(sessionID: String, itemID: String, sku: String?) {
        self.sessionID = sessionID
        self.itemID = itemID
        self.sku = sku
    }
}

/// How the seller left the review flow.
public enum ItemReviewOutcome: Equatable, Sendable {
    /// The item is saved as an inventory item ready to list; its draft on this iPhone is done.
    case saved(sku: String)
    /// The photos have to change before the item can be reviewed.
    case editPhotos
    /// The seller left the review without saving; the item stays a draft.
    case back
}
