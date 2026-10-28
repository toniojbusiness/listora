import APIClient
import Core
import InventoryFeature
import MarketplacesFeature

extension AppDependencies {
    /// What the app shows of each marketplace (docs/features/verified-features.md): the item
    /// screen's refresh and Settings > Listing refresh only where refresh passed live.
    static func makeFeatures(_ apiClient: APIClient, _ inventory: InventoryEnvironment) -> MarketplaceFeatures {
        let features = MarketplaceFeatures(load: MarketplaceFeaturesService.loader(client: apiClient.client))
        inventory.features = features
        return features
    }
}
