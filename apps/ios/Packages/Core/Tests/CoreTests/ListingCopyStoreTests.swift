import Core
import Foundation
import Testing

struct ListingCopyStoreTests {
    let store = ListingCopyStore(
        directory: URL.temporaryDirectory.appending(path: "ListingCopyStoreTests-\(UUID().uuidString)"),
    )
    let itemID = UUID().uuidString.lowercased()

    @Test
    func `keeps each marketplace's edit per item until it is removed`() throws {
        #expect(store.edits(itemID: itemID).isEmpty)
        let ebay = ListingCopy(title: "Acme flannel shirt M", description: "Soft flannel.")
        let depop = ListingCopy(title: "Flannel", description: "Cozy.", hashtags: ["flannel", "vintage"])
        try store.save(ebay, marketplace: "ebay", itemID: itemID)
        try store.save(depop, marketplace: "depop", itemID: itemID)
        #expect(store.edits(itemID: itemID) == ["ebay": ebay, "depop": depop])
        #expect(store.edits(itemID: UUID().uuidString).isEmpty, "another item has no edits")

        try store.save(nil, marketplace: "ebay", itemID: itemID)
        #expect(store.edits(itemID: itemID) == ["depop": depop])
        store.removeAll(itemID: itemID)
        #expect(store.edits(itemID: itemID).isEmpty)
    }

    @Test
    func `refuses an item id that is not a UUID`() {
        #expect(throws: ListingCopyStoreError.invalidItemID) {
            try store.save(ListingCopy(title: "x", description: ""), marketplace: "ebay", itemID: "../escape")
        }
    }
}
