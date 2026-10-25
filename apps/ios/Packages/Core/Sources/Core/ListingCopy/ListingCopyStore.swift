import Foundation

/// A marketplace's version of an item's copy: what the seller wants that marketplace's listing to
/// say. Depop has no title; its ``title`` is a short headline that never reaches Depop.
public struct ListingCopy: Codable, Equatable, Sendable {
    public var title: String
    public var description: String
    /// Without the `#`. Only Depop shows hashtags.
    public var hashtags: [String]

    public init(title: String, description: String, hashtags: [String] = []) {
        self.title = title
        self.description = description
        self.hashtags = hashtags
    }
}

/// The marketplace copy a seller edited during review, kept on this iPhone per item and
/// marketplace (the contract's marketplace id, for example `ebay`). The analysis's own variants
/// stay on the server; this holds only the seller's changes to them until the item's draft
/// listings exist (createListing, plan task T-19), which then carry the copy.
///
/// One JSON file per item, written atomically, so a crash never leaves half an edit.
public struct ListingCopyStore: Sendable {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// Application Support, which is backed up and never purged.
    public static func defaultDirectory() -> URL {
        URL.applicationSupportDirectory.appending(path: "ListingCopy", directoryHint: .isDirectory)
    }

    /// The seller's edits of an item's copy, by marketplace; empty when there are none or the file
    /// cannot be read.
    public func edits(itemID: String) -> [String: ListingCopy] {
        guard let data = try? Data(contentsOf: fileURL(itemID: itemID)),
              let edits = try? JSONDecoder().decode([String: ListingCopy].self, from: data)
        else { return [:] }
        return edits
    }

    /// Stores the seller's copy for one marketplace, or removes it when `copy` is nil.
    public func save(_ copy: ListingCopy?, marketplace: String, itemID: String) throws {
        var edits = edits(itemID: itemID)
        edits[marketplace] = copy
        let url = try fileURL(itemID: itemID)
        if edits.isEmpty {
            try? FileManager.default.removeItem(at: url)
            return
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(edits).write(
            to: url,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication],
        )
    }

    /// Forgets every edit of an item.
    public func removeAll(itemID: String) {
        guard let url = try? fileURL(itemID: itemID) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    /// Item ids are the server's UUIDs; anything else never becomes a path.
    private func fileURL(itemID: String) throws(ListingCopyStoreError) -> URL {
        guard let uuid = UUID(uuidString: itemID) else { throw .invalidItemID }
        return directory.appending(path: "\(uuid.uuidString.lowercased()).json", directoryHint: .notDirectory)
    }
}

public enum ListingCopyStoreError: Error, Equatable, Sendable {
    case invalidItemID
}
