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
}
