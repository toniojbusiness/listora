/// A sticker to print (docs/features/pack-check.md, "Item stickers"): an item's, which the item
/// screen and the listing flow ask for and a scan at the packing table reads (its QR code holds
/// `LISTORA:<SKU>`); or a bin's (docs/features/storage-bins.md), whose QR code holds
/// `LISTORA-BIN:<code>`, scanned to put an item in the bin.
public struct StickerRequest: Hashable, Sendable, Identifiable {
    public enum Kind: Hashable, Sendable {
        case item
        case bin
    }

    public let kind: Kind
    /// The item's SKU, or the bin's code.
    public let sku: String
    /// The item's title, or where the bin is ("Garage shelf 3").
    public let title: String?
    /// The item's bin code, `B-12`.
    public let locationCode: String?

    public var id: String {
        kind == .bin ? "bin:\(sku)" : sku
    }

    public init(sku: String, title: String?, locationCode: String?) {
        kind = .item
        self.sku = sku
        self.title = title
        self.locationCode = locationCode
    }

    /// A bin's sticker: its code, big, and where it is.
    public init(binCode: String, label: String?) {
        kind = .bin
        sku = BinCode.normalized(binCode)
        title = label
        locationCode = nil
    }

    /// What the sticker's QR code holds.
    public var code: String {
        switch kind {
        case .item: "LISTORA:\(sku)"
        case .bin: BinCode.stickerPayload(sku)
        }
    }
}
