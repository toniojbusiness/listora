import APIClient
import Core
import Foundation
import SwiftUI

/// Everything the inventory, item, and listing screens need, built once at launch by
/// `AppDependencies`.
@MainActor
public final class InventoryEnvironment {
    let service: any InventoryService
    let listingCopy: ListingCopyStore
    let detailTiming: DetailTiming
    /// Whether a session exists; signed out, the inventory never calls the API.
    let isSignedIn: @MainActor () -> Bool

    public convenience init(apiClient: APIClient, accessTokens: AccessTokenStore, listingCopy: ListingCopyStore) {
        self.init(
            service: APIInventoryService(client: apiClient.client),
            listingCopy: listingCopy,
            isSignedIn: { accessTokens.grant != nil },
        )
    }

    init(
        service: any InventoryService,
        listingCopy: ListingCopyStore,
        detailTiming: DetailTiming = .standard,
        isSignedIn: @escaping @MainActor () -> Bool = { true },
    ) {
        self.service = service
        self.listingCopy = listingCopy
        self.detailTiming = detailTiming
        self.isSignedIn = isSignedIn
    }

    func makeListModel() -> InventoryListModel {
        InventoryListModel(service: service, isSignedIn: isSignedIn)
    }

    func makeDetailModel(itemID: String) -> ItemDetailModel {
        ItemDetailModel(itemID: itemID, service: service, timing: detailTiming)
    }

    func makeListingFlow(item: Item) -> ListingFlowModel {
        ListingFlowModel(item: item, service: service, listingCopy: listingCopy)
    }
}
