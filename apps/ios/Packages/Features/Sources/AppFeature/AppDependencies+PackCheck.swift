import APIClient
import Foundation
import InventoryFeature
import PackCheckFeature
import PhoneExecutionFeature
import SalesFeature
import SwiftUI

/// Pack check's place in the app (docs/features/pack-check.md): Sales > Pack orders, and the
/// item screen's sticker.
extension AppDependencies {
    static func makePackCheck(
        _ apiClient: APIClient,
        _ accessTokens: AccessTokenStore,
        _ phone: PhoneExecutionEnvironment,
        _ launchOptions: DebugLaunchOptions,
        _ defaults: UserDefaults,
    ) -> PackCheckEnvironment {
        PackCheckEnvironment(
            apiClient: apiClient,
            accessTokens: accessTokens,
            phoneWork: phone.runner,
            scannedCodes: launchOptions.scannedCodes,
            defaults: defaults,
        )
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

    /// The item screen's "Print sticker", and its offer after listing while Pack check is on.
    func attach(to inventory: InventoryEnvironment) {
        inventory.stickerScreen = { [self] request in AnyView(stickerScreen(request)) }
        inventory.offersStickerAfterListing = { [settings] in settings.isEnabled }
    }
}
