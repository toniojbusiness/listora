import APIClient
import Core
import Foundation
import ListoraAPI

/// An inventory with nothing in it, for SwiftUI previews.
private struct EmptyInventoryService: InventoryService {
    func items(_: InventoryQuery, cursor _: String?) async throws(APIFailure) -> ItemPage {
        ItemPage(items: [], nextCursor: nil)
    }

    func item(id _: String) async throws(APIFailure) -> Item {
        throw .networkUnavailable
    }

    func replaceItem(id _: String, with _: Components.Schemas.ItemReplace) async throws(APIFailure) -> Item {
        throw .networkUnavailable
    }

    func deleteItem(id _: String, leavingListings _: Bool) async throws(APIFailure) {
        throw .networkUnavailable
    }

    func floors(itemID _: String) async throws(APIFailure) -> [Components.Schemas.MarketplaceFloor] {
        []
    }

    func connections() async throws(APIFailure) -> [Connection] {
        []
    }

    func analysisVariants(analysisID _: String) async throws(APIFailure) -> [Components.Schemas.VariantSuggestion] {
        []
    }

    func operations(listingID _: String) async throws(APIFailure) -> [Operation] {
        []
    }

    func waitForChange(itemID _: String, after: String?, waitSeconds: Int) async throws(APIFailure) -> ItemChangeWait {
        if after != nil {
            try? await Task.sleep(for: .seconds(waitSeconds))
        }
        return ItemChangeWait(changed: after == nil, token: "preview")
    }

    func events(operationID _: String) async throws(APIFailure) -> [OperationEvent] {
        []
    }

    func activity(itemID _: String, cursor _: String?) async throws(APIFailure) -> ActivityPage {
        ActivityPage(entries: [], nextCursor: nil)
    }

    func createListing(
        itemID _: String,
        marketplace _: KnownMarketplace,
        variant _: ListingVariant,
        idempotencyKey _: String,
    ) async throws(APIFailure) -> Listing {
        throw .networkUnavailable
    }

    func marketplaceCategories(
        itemID _: String,
        marketplace _: String,
    ) async throws(APIFailure) -> Components.Schemas.MarketplaceCategories {
        Components.Schemas.MarketplaceCategories(likely: [], choices: [])
    }

    func replaceDraft(listingID _: String, variant _: ListingVariant) async throws(APIFailure) -> Listing {
        throw .networkUnavailable
    }

    func perform(_: ListingRequest, idempotencyKey _: String) async throws(APIFailure) -> Listing {
        throw .networkUnavailable
    }

    func retry(operationID _: String, idempotencyKey _: String) async throws(APIFailure) -> Operation {
        throw .networkUnavailable
    }

    func tryNow(operationID _: String, idempotencyKey _: String) async throws(APIFailure) -> Operation {
        throw .networkUnavailable
    }
}

extension InventoryEnvironment {
    /// An empty inventory, for previews.
    static var preview: InventoryEnvironment {
        InventoryEnvironment(
            service: EmptyInventoryService(),
            listingCopy: ListingCopyStore(directory: URL.temporaryDirectory.appending(path: "ListingCopyPreview")),
        )
    }
}
