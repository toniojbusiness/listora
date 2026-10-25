import APIClient
import Core
import Foundation
import SwiftUI

/// Opens the task an assisted listing waits on (the task inbox's screen, from `AppDependencies`):
/// the item, the operation, and what to do once the task is done or dismissed.
public typealias TaskDestination = @MainActor (
    _ itemID: String,
    _ operationID: String,
    _ onFinished: @escaping @MainActor () -> Void,
) -> AnyView

/// Everything the inventory, item, and listing screens need, built once at launch by
/// `AppDependencies`.
@MainActor
public final class InventoryEnvironment {
    let service: any InventoryService
    let listingCopy: ListingCopyStore
    let detailTiming: DetailTiming
    /// Whether a session exists; signed out, the inventory never calls the API.
    let isSignedIn: @MainActor () -> Bool
    /// The task screen for an assisted step; without one, the item screen offers no "Open task".
    let taskDestination: TaskDestination?

    public convenience init(
        apiClient: APIClient,
        accessTokens: AccessTokenStore,
        listingCopy: ListingCopyStore,
        taskDestination: TaskDestination? = nil,
    ) {
        self.init(
            service: APIInventoryService(client: apiClient.client),
            listingCopy: listingCopy,
            isSignedIn: { accessTokens.grant != nil },
            taskDestination: taskDestination,
        )
    }

    init(
        service: any InventoryService,
        listingCopy: ListingCopyStore,
        detailTiming: DetailTiming = .standard,
        isSignedIn: @escaping @MainActor () -> Bool = { true },
        taskDestination: TaskDestination? = nil,
    ) {
        self.service = service
        self.listingCopy = listingCopy
        self.detailTiming = detailTiming
        self.isSignedIn = isSignedIn
        self.taskDestination = taskDestination
    }

    func makeListModel() -> InventoryListModel {
        InventoryListModel(service: service, isSignedIn: isSignedIn)
    }

    func makeDetailModel(itemID: String) -> ItemDetailModel {
        ItemDetailModel(itemID: itemID, service: service, timing: detailTiming)
    }

    /// The List flow, with `marketplace` (the row the seller tapped List on) selected.
    func makeListingFlow(item: Item, marketplace: String? = nil) -> ListingFlowModel {
        ListingFlowModel(item: item, service: service, listingCopy: listingCopy, marketplace: marketplace)
    }
}
