/// What the Add Item flow hands to the batch's rapid review: the items of a batch (or of a thrift
/// run's kept drafts) the seller can review now, in haul order. The review feature implements the screens; Add Item
/// only knows this
/// request and the events back, so neither imports the other.
public struct BatchReviewRequest: Hashable, Sendable {
    public struct Item: Hashable, Sendable {
        /// The ``InteractionMeter`` session the item's review is measured in (its draft's id).
        public let sessionID: String
        /// The server item (`Item.id`).
        public let itemID: String
        public let sku: String?

        public init(sessionID: String, itemID: String, sku: String?) {
            self.sessionID = sessionID
            self.itemID = itemID
            self.sku = sku
        }
    }

    /// Where the items come from, for the review's words.
    public enum Source: Hashable, Sendable {
        /// A haul shot as a batch (docs/features/batch.md).
        case batch
        /// The drafts a thrift run kept (docs/features/thrift-scan.md, "Upgrading drafts").
        case scanRun
    }

    /// The server batch (`ItemBatch.id`), or the thrift run on this iPhone.
    public let batchID: String
    public let items: [Item]
    public let source: Source
    /// The batch's own ``InteractionMeter`` session (capture, grouping, the batch screen), so the
    /// review's summary can show the whole batch's time.
    public let batchSessionID: String

    public init(batchID: String, items: [Item], batchSessionID: String, source: Source = .batch) {
        self.batchID = batchID
        self.items = items
        self.source = source
        self.batchSessionID = batchSessionID
    }
}

/// What happened in a batch's rapid review, as it happens.
public enum BatchReviewEvent: Equatable, Sendable {
    /// The seller approved an item: it is saved with its SKU, ready to list. `summary` is the
    /// item's own measured interaction (its review), when the review measured it.
    case saved(sessionID: String, itemID: String, sku: String, summary: InteractionSummary?)
    /// The seller left the review.
    case finished
}
