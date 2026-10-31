import Foundation

/// Storage bins (docs/features/storage-bins.md): where items are kept, named by the short code on
/// the bin's sticker, `B-12`. A bin sticker's QR code holds `LISTORA-BIN:<code>`, which never
/// reads as an item sticker (`LISTORA:<SKU>`).
public enum BinCode {
    public static let stickerPrefix = "LISTORA-BIN:"

    /// What a bin's sticker QR code holds.
    public static func stickerPayload(_ code: String) -> String {
        stickerPrefix + normalized(code)
    }

    /// The bin code a scan read: a bin sticker's QR code, or a code typed in instead. An item's
    /// sticker or a shipping label is nil, so it can't be taken for a bin.
    public static func scanned(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.uppercased().hasPrefix(stickerPrefix) {
            let code = normalized(String(trimmed.dropFirst(stickerPrefix.count)))
            return code.isEmpty ? nil : code
        }
        if trimmed.uppercased().hasPrefix("LISTORA:") {
            return nil
        }
        let code = normalized(trimmed)
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ./-")
        guard !code.isEmpty, code.count <= 32,
              code.unicodeScalars.allSatisfy(allowed.contains),
              code.unicodeScalars.contains(where: CharacterSet.alphanumerics.contains)
        else {
            return nil
        }
        return code
    }

    /// The code as Listora stores it: trimmed, single spaces, capitals (`b-12` is `B-12`).
    public static func normalized(_ code: String) -> String {
        code.split(whereSeparator: \.isWhitespace).joined(separator: " ").uppercased()
    }

    /// "Find it: bin B-12" for one item, "Find them: bins B-3, B-12" for an order's items in
    /// more than one; nil when none is in a bin.
    public static func findIt(_ codes: [String?], items: Int? = nil) -> String? {
        var seen = Set<String>()
        let unique = codes.compactMap(\.self).filter { !$0.isEmpty && seen.insert($0).inserted }
        guard let first = unique.first else { return nil }
        let many = (items ?? codes.count) > 1
        if unique.count == 1 {
            return many ? "Find them: bin \(first)" : "Find it: bin \(first)"
        }
        return "Find them: bins \(unique.joined(separator: ", "))"
    }
}

/// A bin the seller picked for items: its id and code.
public struct BinChoice: Hashable, Sendable {
    public let id: String
    public let code: String

    public init(id: String, code: String) {
        self.id = id
        self.code = code
    }
}

/// Putting items in a bin (the item's screen, a saved item, a run's kept items): which items,
/// and the bin they are in now (`nil` when none, or when they are in different ones).
public struct BinRequest: Hashable, Sendable, Identifiable {
    public let itemIDs: [String]
    public let current: BinChoice?

    public var id: String {
        itemIDs.joined(separator: ",")
    }

    public init(itemIDs: [String], current: BinChoice? = nil) {
        self.itemIDs = itemIDs
        self.current = current
    }
}
