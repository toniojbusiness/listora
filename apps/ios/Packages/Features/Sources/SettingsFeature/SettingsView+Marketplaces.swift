import DesignSystem
import SwiftUI

/// The Marketplaces section, apart so the view's body stays short.
extension SettingsView {
    @ViewBuilder
    var marketplacesSection: some View {
        if screens.linkAccounts != nil || screens.marketplaces != nil || screens.imports != nil
            || screens.listingRefresh != nil || screens.priceDrops != nil
        {
            Section {
                if screens.linkAccounts != nil {
                    NavigationLink(value: SettingsDestination.linkAccounts) {
                        ListRow(
                            "Linked marketplaces",
                            subtitle: marketplacesSummary?.text ?? "Poshmark, Mercari, Depop, and eBay",
                            systemImage: "person.badge.key",
                        ) {
                            if marketplacesSummary?.needsAttention == true {
                                StatusBadge("Needs attention", tone: .actionNeeded)
                                    .accessibilityIdentifier("settings.marketplaces.attention")
                            }
                        }
                    }
                    .accessibilityIdentifier("settings.linkAccounts")
                }
                if screens.marketplaces != nil {
                    NavigationLink(value: SettingsDestination.marketplaces) {
                        ListRow(
                            "How Listora connects",
                            subtitle: "Connect eBay, and check each marketplace's connection.",
                            systemImage: "link",
                        )
                    }
                    .accessibilityIdentifier("settings.marketplaces")
                }
                if screens.imports != nil {
                    NavigationLink(value: SettingsDestination.imports) {
                        ListRow(
                            "Import your listings",
                            subtitle: "Bring in what you already have for sale on your marketplaces.",
                            systemImage: "square.and.arrow.down",
                        )
                    }
                    .accessibilityIdentifier("settings.imports")
                }
                if screens.listingRefresh != nil {
                    NavigationLink(value: SettingsDestination.listingRefresh) {
                        ListRow(
                            "Listing refresh",
                            subtitle: "Keep listings that haven't sold fresh on each marketplace",
                            systemImage: "arrow.clockwise",
                        ) {
                            if features?.isTestingEverywhere(.listingRefresh) == true {
                                TestingTag()
                            }
                        }
                    }
                    .accessibilityIdentifier("settings.listingRefresh")
                }
                if screens.priceDrops != nil {
                    NavigationLink(value: SettingsDestination.priceDrops) {
                        ListRow(
                            "Price drops",
                            subtitle: "Lower the price of listings that haven't sold, step by step",
                            systemImage: "tag",
                        ) {
                            if features?.isTestingEverywhere(.priceDrops) == true {
                                TestingTag()
                            }
                        }
                    }
                    .accessibilityIdentifier("settings.priceDrops")
                }
            } header: {
                SectionHeader("Marketplaces")
            }
            .listRowBackground(Palette.surface.color)
        }
    }
}
