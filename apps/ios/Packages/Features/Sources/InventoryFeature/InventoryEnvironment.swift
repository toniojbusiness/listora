import APIClient
import Core
import Foundation
import ListoraAPI
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

/// Opens the task an assisted listing waits on (the task inbox's screen, from `AppDependencies`):
/// the item, the operation, and what to do once the task is done or dismissed.
public typealias TaskDestination = @MainActor (
    _ itemID: String,
    _ operationID: String,
    _ onFinished: @escaping @MainActor () -> Void,
) -> AnyView

/// The review of a server item that is still a draft (the review feature's flow), handed over by
/// `AppDependencies` so the two features never import each other.
public typealias ItemReviewScreen = @MainActor (
    ItemReviewRequest,
    _ onFinished: @escaping @MainActor (ItemReviewOutcome) -> Void,
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
    /// Opens the sign-in, for a signed-out screen's Sign in button.
    let onSignIn: @MainActor () -> Void
    /// "Mark as sold" and the sale screen; without them the item screen offers neither.
    let saleScreens: SaleScreens?
    /// The task screen for an assisted step; without one, the item screen offers no "Open task".
    let taskDestination: TaskDestination?
    /// Reviews a draft item, also one that is not a draft on this iPhone (made on another device,
    /// or before a reinstall); without one, the item screen offers no "Review item".
    public var reviewScreen: ItemReviewScreen?
    /// A status filter for the list to apply when it next appears (the Today card for drafts).
    private var requestedStatus: Components.Schemas.KnownItemStatus?

    /// `phoneWork` runs at once the listing changes queued for this phone.
    public convenience init(
        apiClient: APIClient,
        accessTokens: AccessTokenStore,
        listingCopy: ListingCopyStore,
        saleScreens: SaleScreens? = nil,
        taskDestination: TaskDestination? = nil,
        onSignIn: @escaping @MainActor () -> Void = {},
        phoneWork: (any PhoneWorkTrigger)? = nil,
    ) {
        self.init(
            service: APIInventoryService(client: apiClient.client) { [weak phoneWork] in
                phoneWork?.runPhoneWork(.userAction)
            },
            listingCopy: listingCopy,
            isSignedIn: { accessTokens.grant != nil },
            onSignIn: onSignIn,
            saleScreens: saleScreens,
            taskDestination: taskDestination,
        )
    }

    init(
        service: any InventoryService,
        listingCopy: ListingCopyStore,
        detailTiming: DetailTiming = .standard,
        isSignedIn: @escaping @MainActor () -> Bool = { true },
        onSignIn: @escaping @MainActor () -> Void = {},
        saleScreens: SaleScreens? = nil,
        taskDestination: TaskDestination? = nil,
    ) {
        self.service = service
        self.listingCopy = listingCopy
        self.detailTiming = detailTiming
        self.isSignedIn = isSignedIn
        self.onSignIn = onSignIn
        self.saleScreens = saleScreens
        self.taskDestination = taskDestination
    }

    /// The item screen, for another tab's navigation stack (a Today card opens it).
    public func itemDetail(itemID: String) -> some View {
        ItemDetailView(environment: self, itemID: itemID)
    }

    /// Forgets the seller's inventory layout, back to the photo grid (`LISTORA_RESET_LOCAL_DATA`).
    public static func resetLocalData(defaults: UserDefaults) {
        defaults.removeObject(forKey: InventoryLayout.storageKey)
    }

    /// Shows the drafts the next time the inventory appears.
    public func showDrafts() {
        requestedStatus = .draft
    }

    /// The status filter asked for since the list last appeared, once.
    func takeRequestedStatus() -> Components.Schemas.KnownItemStatus? {
        defer { requestedStatus = nil }
        return requestedStatus
    }

    func makeListModel() -> InventoryListModel {
        InventoryListModel(service: service, isSignedIn: isSignedIn)
    }

    func makeDetailModel(itemID: String) -> ItemDetailModel {
        ItemDetailModel(itemID: itemID, service: service, timing: detailTiming)
    }

    func makeActivityModel(itemID: String) -> ItemActivityModel {
        ItemActivityModel(itemID: itemID, service: service)
    }

    /// The List flow, with `marketplace` (the row the seller tapped List on) selected.
    func makeListingFlow(item: Item, marketplace: String? = nil) -> ListingFlowModel {
        ListingFlowModel(item: item, service: service, listingCopy: listingCopy, marketplace: marketplace)
    }
}
