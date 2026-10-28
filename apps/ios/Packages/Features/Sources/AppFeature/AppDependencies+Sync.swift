import APIClient
import Core
import MarketplaceLinkingFeature
import PhoneExecutionFeature
import SalesFeature
import SwiftUI
import SyncFeature
import TodayFeature

extension AppDependencies {
    /// The sync of the linked marketplaces (docs/features/sync.md): it names the work the phone
    /// runs and runs the reads Listora hands it at once; Today and Sales get Sync now and their
    /// pull to refresh, Link accounts each marketplace's "Last synced".
    static func makeSync(
        _ apiClient: APIClient,
        _ accessTokens: AccessTokenStore,
        _ phone: PhoneExecutionEnvironment,
        _ screens: (today: TodayEnvironment, sales: SalesEnvironment),
        _ linkAccounts: LinkAccountsModel,
    ) -> SyncModel {
        let sync = SyncModel(
            service: APISyncService(client: apiClient.client),
            isSignedIn: { accessTokens.grant != nil },
        )
        sync.progress = phone.runner
        sync.phoneWork = phone.runner
        let button: @MainActor () -> AnyView = { AnyView(SyncNowButton(model: sync)) }
        screens.today.sync = sync
        screens.today.syncButton = button
        screens.sales.sync = sync
        screens.sales.syncButton = button
        linkAccounts.sync = sync
        return sync
    }
}
