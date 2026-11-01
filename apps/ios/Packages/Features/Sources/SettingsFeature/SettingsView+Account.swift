import DesignSystem
import SwiftUI

extension SettingsView {
    /// Invite someone to their own Listora; only for the account that set this one up.
    @ViewBuilder
    var peopleSection: some View {
        if let invites, invites.canInvite {
            Section {
                NavigationLink(value: SettingsDestination.people) {
                    ListRow(
                        "Invite people",
                        subtitle: invites.peopleCount == 0
                            ? "Give someone their own, separate Listora"
                            : "\(invites.peopleCount) \(invites.peopleCount == 1 ? "person" : "people") joined",
                        systemImage: "person.2",
                    )
                }
                .accessibilityIdentifier("settings.people")
            } header: {
                SectionHeader("People")
            }
            .listRowBackground(Palette.surface.color)
        }
    }

    /// The screens of the account's own settings: its invites and its description style.
    @ViewBuilder
    func accountScreen(for destination: SettingsDestination) -> some View {
        switch destination {
        case .people:
            if let invites {
                InvitesView(model: invites)
            }
        case .descriptionStyle:
            if let descriptionStyle {
                DescriptionStyleView(model: descriptionStyle)
            }
        default:
            EmptyView()
        }
    }

    /// Selling > Description style: how Listora's AI writes the seller's Depop drafts.
    @ViewBuilder
    var descriptionStyleRow: some View {
        if descriptionStyle != nil {
            NavigationLink(value: SettingsDestination.descriptionStyle) {
                ListRow(
                    "Description style",
                    subtitle: "How Listora writes your Depop listings",
                    systemImage: "text.quote",
                )
            }
            .accessibilityIdentifier("settings.descriptionStyle")
        }
    }

    /// Selling has a row to show.
    var showsSellingSection: Bool {
        screens.notifications != nil || screens.saleEmails != nil || screens.packCheck != nil
            || screens.storageBins != nil || descriptionStyle != nil
    }
}
