import Core
import DesignSystem
import SwiftUI

extension SettingsView {
    /// Test mode (docs/features/test-mode.md): only on the deployment owner's account, which may
    /// live-test the marketplace features that haven't passed live yet. Every other account has
    /// no Test mode, so the section never shows for them.
    @ViewBuilder
    var testModeSection: some View {
        if let features, features.testMode != .unavailable {
            Section {
                Toggle(isOn: Binding(
                    get: { features.testMode == .enabled },
                    set: { value in Task { await features.setTestMode(value) } },
                )) {
                    ListRow(
                        "Test mode",
                        subtitle: "Shows features that haven't passed a live test yet, tagged Testing",
                        systemImage: "testtube.2",
                    )
                }
                .tint(Palette.brand.color)
                .accessibilityIdentifier("settings.testMode")
            } header: {
                SectionHeader("Testing")
            } footer: {
                Text(features.testModeError
                    ?? "Only your account sees this. Each test's result goes in the owner log. "
                    + "Accounts Listora only reads stay read-only.")
                    .font(Typography.footnote)
                    .foregroundStyle(features.testModeError == nil ? Palette.textSecondary : Palette.danger)
                    .accessibilityIdentifier("settings.testMode.footer")
            }
            .listRowBackground(Palette.surface.color)
        }
    }
}
