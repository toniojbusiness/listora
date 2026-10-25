import APIClient
import Core
import Foundation
import SwiftUI

/// Everything the sales screens need, built once at launch by `AppDependencies`. The item screen
/// reaches "Mark as sold" and a sale through ``markSold(_:onRecorded:)`` and ``saleScreen(saleID:)``.
@MainActor
public final class SalesEnvironment {
    let service: any SalesService
    let timing: SalesTiming
    /// Whether a session exists; signed out, the sales list never calls the API.
    let isSignedIn: @MainActor () -> Bool

    public convenience init(apiClient: APIClient, accessTokens: AccessTokenStore) {
        self.init(service: APISalesService(client: apiClient.client), isSignedIn: { accessTokens.grant != nil })
    }

    init(
        service: any SalesService,
        timing: SalesTiming = .standard,
        isSignedIn: @escaping @MainActor () -> Bool = { true },
    ) {
        self.service = service
        self.timing = timing
        self.isSignedIn = isSignedIn
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

    func makeListModel() -> SalesListModel {
        SalesListModel(service: service, isSignedIn: isSignedIn)
    }

    func makeDetailModel(saleID: String) -> SaleDetailModel {
        SaleDetailModel(saleID: saleID, service: service, timing: timing)
    }
}
