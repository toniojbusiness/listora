import APIClient
import Core
import Foundation
import ListoraAPI
import Observation
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
    /// The marketplace work this iPhone runs now, for the item screen's progress; without it,
    /// the screen shows only the server's status.
    public weak var phoneProgress: (any PhoneWorkProgressSource)?
    /// A filter for the list to apply when it next appears (the Today card for drafts).
    private var requestedFilter: InventoryFilter?
    /// An item to open, with List everywhere, when the list next appears (List it now).
    private var requestedItem: String?
    /// How many items need the seller, for the Inventory tab's badge.
    public let attention: InventoryAttention

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
        attention = InventoryAttention(service: service, isSignedIn: isSignedIn)
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
        requestedFilter = .drafts
    }

    /// Opens the item the next time the inventory appears, with List everywhere open.
    public func listItem(id: String) {
        requestedItem = id
    }

    /// The item asked for since the list last appeared, once.
    func takeRequestedItem() -> String? {
        defer { requestedItem = nil }
        return requestedItem
    }

    /// The filter asked for since the list last appeared, once.
    func takeRequestedFilter() -> InventoryFilter? {
        defer { requestedFilter = nil }
        return requestedFilter
    }

    func makeListModel() -> InventoryListModel {
        InventoryListModel(service: service, isSignedIn: isSignedIn)
    }

    /// One change for these items (Inventory's selection, or one item's List everywhere).
    func makeBulkAction(items: [ItemSummary]) -> BulkActionModel {
        BulkActionModel(items: items, service: service, listingCopy: listingCopy, timing: detailTiming)
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

/// How many items need the seller (a listing whose newest change failed or waits for them), for
/// the Inventory tab's badge and the Needs you filter. Read when the app comes to the front and
/// each time Inventory loads; at most one page is counted, so a badge never claims more than it
/// read (`hasMore` then says there are more).
@MainActor
@Observable
public final class InventoryAttention {
    /// The items counted, at most one page.
    public private(set) var total = 0
    public private(set) var hasMore = false
    private let service: any InventoryService
    private let isSignedIn: @MainActor () -> Bool

    init(service: any InventoryService, isSignedIn: @escaping @MainActor () -> Bool) {
        self.service = service
        self.isSignedIn = isSignedIn
    }

    /// Reads the count again; a failed read keeps the last one.
    public func refresh() async {
        guard isSignedIn() else {
            total = 0
            hasMore = false
            return
        }
        guard let page = try? await service.items(InventoryQuery(filter: .needsYou), cursor: nil) else { return }
        total = page.items.count
        hasMore = page.nextCursor != nil
    }
}
