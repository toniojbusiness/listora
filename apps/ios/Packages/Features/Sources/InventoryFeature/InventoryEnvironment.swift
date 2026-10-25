import APIClient
import Core
import Foundation
import SwiftUI

/// The sales screens the item screen opens, which the sales feature implements: "Mark as sold"
/// for an item, and one sale.
@MainActor
public struct SaleScreens {
    /// The "Mark as sold" sheet; its second argument gets the recorded sale's id.
    public let markSold: (MarkSoldRequest, @escaping @MainActor (String) -> Void) -> AnyView
    /// A sale's screen, pushed on the item's navigation stack.
    public let sale: (String) -> AnyView

    public init(
        markSold: @escaping (MarkSoldRequest, @escaping @MainActor (String) -> Void) -> AnyView,
        sale: @escaping (String) -> AnyView,
    ) {
        self.markSold = markSold
        self.sale = sale
    }
}

/// Everything the inventory, item, and listing screens need, built once at launch by
/// `AppDependencies`.
@MainActor
public final class InventoryEnvironment {
    let service: any InventoryService
    let listingCopy: ListingCopyStore
    let detailTiming: DetailTiming
    /// Whether a session exists; signed out, the inventory never calls the API.
    let isSignedIn: @MainActor () -> Bool
    /// "Mark as sold" and the sale screen; without them the item screen offers neither.
    let saleScreens: SaleScreens?

    public convenience init(
        apiClient: APIClient,
        accessTokens: AccessTokenStore,
        listingCopy: ListingCopyStore,
        saleScreens: SaleScreens? = nil,
    ) {
        self.init(
            service: APIInventoryService(client: apiClient.client),
            listingCopy: listingCopy,
            isSignedIn: { accessTokens.grant != nil },
            saleScreens: saleScreens,
        )
    }

    init(
        service: any InventoryService,
        listingCopy: ListingCopyStore,
        detailTiming: DetailTiming = .standard,
        isSignedIn: @escaping @MainActor () -> Bool = { true },
        saleScreens: SaleScreens? = nil,
    ) {
        self.service = service
        self.listingCopy = listingCopy
        self.detailTiming = detailTiming
        self.isSignedIn = isSignedIn
        self.saleScreens = saleScreens
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
