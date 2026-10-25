import DesignSystem
import SwiftUI

/// The gear in the Today and Sales headers that opens Settings. While a marketplace connection
/// needs attention it carries a dot, which the tab badge on Settings used to show.
struct SettingsButton: View {
    let needsAttention: Bool
    let action: @MainActor () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "gearshape")
                .overlay(alignment: .topTrailing) {
                    if needsAttention {
                        Circle()
                            .fill(Palette.warning.color)
                            .frame(width: 9, height: 9)
                            .offset(x: 3, y: -2)
                    }
                }
        }
        .accessibilityLabel("Settings")
        .accessibilityValue(needsAttention ? "A marketplace connection needs attention" : "")
        .accessibilityIdentifier("settings.open")
    }
}
