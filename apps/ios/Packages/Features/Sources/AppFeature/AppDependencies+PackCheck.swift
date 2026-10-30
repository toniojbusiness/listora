import APIClient
import Core
import Foundation
import InventoryFeature
import PackCheckFeature
import PhoneExecutionFeature
import SalesFeature
import SwiftUI

/// The Sales tab, and Pack check's place in the app (docs/features/pack-check.md): Sales > Pack
/// orders, and the item screen's sticker.
extension AppDependencies {
    static func makePackCheck(
        _ apiClient: APIClient,
        _ accessTokens: AccessTokenStore,
        _ phone: PhoneExecutionEnvironment,
        _ build: (configuration: AppConfiguration, launchOptions: DebugLaunchOptions),
        _ defaults: UserDefaults,
    ) -> PackCheckEnvironment {
        let (configuration, launchOptions) = build
        PackCheckEnvironment(
            apiClient: apiClient,
            accessTokens: accessTokens,
            phoneWork: phone.runner,
            sessions: phone.sessions,
            allowsLocalHTTP: configuration.environment.allowsInsecureHTTP,
            scannedCodes: launchOptions.scannedCodes,
            scriptedPrinting: launchOptions.scriptedPrinting,
            defaults: defaults,
        )
    }

    /// Sales: the feed, each sale, and its delists, which run at once on this phone and show the
    /// phone's progress.
    static func makeSales(
        _ apiClient: APIClient,
        _ accessTokens: AccessTokenStore,
        _ showSignIn: @escaping @MainActor () -> Void,
        _ phone: PhoneExecutionEnvironment,
        _ packCheck: PackCheckEnvironment,
    ) -> SalesEnvironment {
        let sales = SalesEnvironment(
            apiClient: apiClient, accessTokens: accessTokens, onSignIn: showSignIn, phoneWork: phone.runner,
            packOrders: packCheck.ordersEntry,
        )
        sales.phoneProgress = phone.runner
        return sales
    }
}

@MainActor
extension PackCheckEnvironment {
    /// The Sales tab's way into the to-ship list, shown while Pack check is on.
    var ordersEntry: PackOrdersEntry {
        PackOrdersEntry(
            isShown: { [settings] in settings.isEnabled },
            screen: { [self] in AnyView(ordersScreen()) },
            refresh: { [self] in await refreshSetting() },
        )
    }

    /// The item screen's "Print sticker" (near the top while Pack check is on), and its offer
    /// after listing while Pack check is on.
    func attach(to inventory: InventoryEnvironment) {
        inventory.stickerScreen = { [self] request in AnyView(stickerScreen(request)) }
        inventory.isPackCheckOn = { [settings] in settings.isEnabled }
    }
}
