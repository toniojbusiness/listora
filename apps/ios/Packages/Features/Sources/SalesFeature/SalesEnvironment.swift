import APIClient
import Core
import Foundation
import SwiftUI

/// The way into Pack check's to-ship list from the Sales tab (another feature's screen, handed
/// over by `AppDependencies`): shown only while Pack check is on.
@MainActor
public struct PackOrdersEntry {
    let isShown: @MainActor () -> Bool
    let screen: @MainActor () -> AnyView
    /// Reads the setting again (each time the Sales tab shows).
    let refresh: @MainActor () async -> Void

    public init(
        isShown: @escaping @MainActor () -> Bool,
        screen: @escaping @MainActor () -> AnyView,
        refresh: @escaping @MainActor () async -> Void = {},
    ) {
        self.isShown = isShown
        self.screen = screen
        self.refresh = refresh
    }
}

/// Everything the sales screens need, built once at launch by `AppDependencies`. The item screen
/// reaches "Mark as sold" and a sale through ``markSold(_:onRecorded:)`` and ``saleScreen(saleID:)``.
@MainActor
public final class SalesEnvironment {
    let service: any SalesService
    let profitService: any ProfitService
    let reportsService: any ReportsService
    let timing: SalesTiming
    /// Whether a session exists; signed out, the sales list never calls the API.
    let isSignedIn: @MainActor () -> Bool
    /// Opens the sign-in, for a signed-out screen's Sign in button.
    let onSignIn: @MainActor () -> Void
    /// Pack check's to-ship list, while Pack check is on.
    let packOrders: PackOrdersEntry?
    /// The work this iPhone runs now, which a sale's delists show while the phone works on them.
    public weak var phoneProgress: (any PhoneWorkProgressSource)?
    /// Syncs the linked marketplaces on a pull to refresh (docs/features/sync.md).
    public weak var sync: (any MarketplaceSync)?
    /// The header's Sync now button.
    public var syncButton: (@MainActor () -> AnyView)?

    /// `phoneWork` runs at once the marketplace changes a sale queued for this phone.
    public convenience init(
        apiClient: APIClient,
        accessTokens: AccessTokenStore,
        onSignIn: @escaping @MainActor () -> Void = {},
        phoneWork: (any PhoneWorkTrigger)? = nil,
        packOrders: PackOrdersEntry? = nil,
    ) {
        self.init(
            service: APISalesService(client: apiClient.client) { [weak phoneWork] in
                phoneWork?.runPhoneWork(.userAction)
            },
            profitService: APIProfitService(client: apiClient.client),
            reportsService: APIReportsService(client: apiClient.client),
            isSignedIn: { accessTokens.grant != nil },
            onSignIn: onSignIn,
            packOrders: packOrders,
        )
    }

    init(
        service: any SalesService,
        profitService: any ProfitService,
        reportsService: any ReportsService,
        timing: SalesTiming = .standard,
        isSignedIn: @escaping @MainActor () -> Bool = { true },
        onSignIn: @escaping @MainActor () -> Void = {},
        packOrders: PackOrdersEntry? = nil,
    ) {
        self.packOrders = packOrders
        self.service = service
        self.profitService = profitService
        self.reportsService = reportsService
        self.timing = timing
        self.isSignedIn = isSignedIn
        self.onSignIn = onSignIn
    }

    /// The "Mark as sold" sheet for an item; `onRecorded` gets the new sale's id.
    public func markSold(
        _ request: MarkSoldRequest,
        onRecorded: @escaping @MainActor (String) -> Void,
    ) -> some View {
        MarkSoldView(model: MarkSoldModel(request: request, service: service, timing: timing), onRecorded: onRecorded)
    }

    /// One sale's screen, for a navigation stack to push.
    public func saleScreen(saleID: String) -> some View {
        SaleDetailView(environment: self, saleID: saleID)
    }

    /// Forgets the sales list's order, back to newest sold first (`LISTORA_RESET_LOCAL_DATA`).
    public static func resetLocalData(defaults: UserDefaults) {
        defaults.removeObject(forKey: SaleSort.storageKey)
    }

    func makeListModel() -> SalesListModel {
        SalesListModel(service: service, isSignedIn: isSignedIn)
    }

    func makeProfitModel() -> ProfitModel {
        ProfitModel(service: profitService, isSignedIn: isSignedIn)
    }

    func makeReportsModel() -> ReportsModel {
        ReportsModel(service: reportsService, isSignedIn: isSignedIn)
    }

    func makeDetailModel(saleID: String) -> SaleDetailModel {
        SaleDetailModel(saleID: saleID, service: service, timing: timing)
    }
}
