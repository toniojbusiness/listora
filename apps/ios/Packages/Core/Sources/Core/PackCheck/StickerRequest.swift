/// An item's sticker to print (docs/features/pack-check.md, "Item stickers"): the item screen and
/// the listing flow ask for it, and Pack check prints it. The QR code holds `LISTORA:<SKU>`, which
/// a scan at the packing table reads.
public struct StickerRequest: Hashable, Sendable, Identifiable {
    public let sku: String
    public let title: String?
    /// The shelf or bin code, `B-12`.
    public let locationCode: String?

    public var id: String {
        sku
    }

    public init(sku: String, title: String?, locationCode: String?) {
        self.sku = sku
        self.title = title
        self.locationCode = locationCode
    }

    /// What the sticker's QR code holds.
    public var code: String {
        "LISTORA:\(sku)"
    }
}
