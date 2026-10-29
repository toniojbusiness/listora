import APIClient
import Core
import InventoryFeature
import MarketplacesFeature
import TasksFeature

extension AppDependencies {
    /// What the app shows of each marketplace (docs/features/verified-features.md): the item
    /// screen's refresh and Settings > Listing refresh only where refresh passed live, and the
    /// owner's Test mode (docs/features/test-mode.md), whose features Inventory and Tasks tag.
    static func makeFeatures(
        _ apiClient: APIClient,
        _ inventory: InventoryEnvironment,
        _ tasks: TasksEnvironment,
    ) -> MarketplaceFeatures {
        let features = MarketplaceFeatures(
            load: MarketplaceFeaturesService.loader(client: apiClient.client),
            saveTestMode: MarketplaceFeaturesService.testModeSaver(client: apiClient.client),
        )
        inventory.features = features
        tasks.features = features
        return features
    }
}
