import DesignSystem
import SwiftUI

/// Dev builds only: the candidate palette themes, each with a swatch of its colors. Choosing one
/// redraws the app in it.
struct DevPaletteSection: View {
    @Binding var selection: PaletteTheme.Key

    var body: some View {
        Section {
            ForEach(PaletteTheme.all) { theme in
                Button {
                    selection = theme.id
                } label: {
                    ListRow(theme.name, subtitle: subtitle(theme)) {
                        Swatch(theme: theme)
                    } trailing: {
                        if selection == theme.id {
                            Image(systemName: "checkmark")
                                .font(Typography.headline)
                                .foregroundStyle(Palette.brand)
                                .accessibilityHidden(true)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == theme.id ? .isSelected : [])
                .accessibilityIdentifier("settings.palette.\(theme.id.rawValue)")
            }
        } header: {
            SectionHeader("Palette", subtitle: "Dev builds only. Pick a direction to compare.")
        }
    }

    private func subtitle(_ theme: PaletteTheme) -> String {
        theme.headingDesign == .serif ? "Serif headings" : "SF Pro headings"
    }
}

/// The theme's background, brand, and soft brand colors, in the current appearance.
private struct Swatch: View {
    let theme: PaletteTheme

    var body: some View {
        HStack(spacing: -Spacing.xs) {
            ForEach(Array([theme.background, theme.brandSoft, theme.brand].enumerated()), id: \.offset) { _, token in
                Circle()
                    .fill(token)
                    .frame(width: 24, height: 24)
                    .overlay(Circle().strokeBorder(theme.separator, lineWidth: 1))
            }
        }
        .accessibilityHidden(true)
    }
}
