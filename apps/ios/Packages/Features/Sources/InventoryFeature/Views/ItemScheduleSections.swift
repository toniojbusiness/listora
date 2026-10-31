import Core
import SwiftUI

/// What Listora does to the item's live listings on its own, under its marketplaces: its refresh
/// cadence (listing-refresh.md) and its price drop (price-drops.md). Each shows once the item is
/// live on a marketplace where that feature passed live (verified-features.md), tagged Testing
/// where it shows only for the owner's Test mode (test-mode.md).
struct ItemScheduleSections: View {
    let item: Item
    let environment: InventoryEnvironment

    var body: some View {
        if let features = environment.features {
            let refreshed = liveMarketplaces(showing: .listingRefresh, features)
            if let service = environment.refreshService, !refreshed.isEmpty {
                ItemRefreshSection(
                    itemID: item.id,
                    service: service,
                    testing: refreshed.allSatisfy { features.isTesting(.listingRefresh, on: $0) },
                )
            }
            let dropped = liveMarketplaces(showing: .priceDrops, features)
            if let service = environment.priceDropService, !dropped.isEmpty {
                ItemPriceDropSection(
                    itemID: item.id,
                    brand: item.details.brand,
                    service: service,
                    testing: dropped.allSatisfy { features.isTesting(.priceDrops, on: $0) },
                )
            }
        }
    }

    /// The marketplaces the item is live on where the feature shows.
    private func liveMarketplaces(
        showing feature: MarketplaceFeatures.Feature,
        _ features: MarketplaceFeatures,
    ) -> [String] {
        item.listings.compactMap { listing in
            let marketplace = listing.marketplace.value1?.rawValue ?? listing.marketplace.value2 ?? ""
            return listing.status.value1 == .active && features.shows(feature, on: marketplace) ? marketplace : nil
        }
    }
}
