import APIClient
import Core
import Foundation
import SwiftUI

/// Everything the Today screen needs, built once at launch by `AppDependencies`. The screens a
/// card opens (item, sale, marketplaces) belong to other features, so the app passes them in.
@MainActor
public final class TodayEnvironment {
    let service: any TodayService
    /// Whether a session exists; signed out, the screen never calls the API.
    let isSignedIn: @MainActor () -> Bool
    /// Opens the sign-in, for a signed-out screen's Sign in button.
    let onSignIn: @MainActor () -> Void
    /// The item screen, pushed on Today's navigation stack.
    let itemDestination: @MainActor (String) -> AnyView
    /// A sale's screen, pushed on Today's navigation stack.
    let saleDestination: @MainActor (String) -> AnyView
    /// The marketplace connections screen, pushed on Today's navigation stack.
    let marketplacesDestination: @MainActor () -> AnyView

    public convenience init(
        apiClient: APIClient,
        accessTokens: AccessTokenStore,
        itemDestination: @escaping @MainActor (String) -> AnyView,
        saleDestination: @escaping @MainActor (String) -> AnyView,
        marketplacesDestination: @escaping @MainActor () -> AnyView,
        onSignIn: @escaping @MainActor () -> Void = {},
    ) {
        self.init(
            service: APITodayService(client: apiClient.client),
            isSignedIn: { accessTokens.grant != nil },
            onSignIn: onSignIn,
            itemDestination: itemDestination,
            saleDestination: saleDestination,
            marketplacesDestination: marketplacesDestination,
        )
    }

    init(
        service: any TodayService,
        isSignedIn: @escaping @MainActor () -> Bool = { true },
        onSignIn: @escaping @MainActor () -> Void = {},
        itemDestination: @escaping @MainActor (String) -> AnyView = { _ in AnyView(EmptyView()) },
        saleDestination: @escaping @MainActor (String) -> AnyView = { _ in AnyView(EmptyView()) },
        marketplacesDestination: @escaping @MainActor () -> AnyView = { AnyView(EmptyView()) },
    ) {
        self.service = service
        self.isSignedIn = isSignedIn
        self.onSignIn = onSignIn
        self.itemDestination = itemDestination
        self.saleDestination = saleDestination
        self.marketplacesDestination = marketplacesDestination
    }

    func makeModel() -> TodayModel {
        TodayModel(service: service, isSignedIn: isSignedIn)
    }

    func makeSettingsModel() -> SummarySettingsModel {
        SummarySettingsModel(service: service)
    }
}
