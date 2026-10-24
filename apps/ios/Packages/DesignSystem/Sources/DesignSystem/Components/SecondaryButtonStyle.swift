import SwiftUI

/// The companion of ``PrimaryButtonStyle`` for the second choice on a screen: full width, brand
/// text on a raised surface with a brand outline.
public struct SecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
        configuration.label
            .font(Typography.headline)
            .foregroundStyle(Palette.brand)
            .frame(maxWidth: .infinity, minHeight: Layout.buttonHeight)
            .padding(.horizontal, Spacing.md)
            .background(Palette.surface, in: shape)
            .overlay(shape.strokeBorder(Palette.brand, lineWidth: 1.5))
            .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
            .contentShape(Rectangle())
    }
}

extension ButtonStyle where Self == SecondaryButtonStyle {
    public static var listoraSecondary: SecondaryButtonStyle {
        SecondaryButtonStyle()
    }
}

#Preview {
    VStack(spacing: Spacing.md) {
        Button("Take photos") {}.buttonStyle(.listoraPrimary)
        Button("Import photos") {}.buttonStyle(.listoraSecondary)
        Button("Import photos") {}.buttonStyle(.listoraSecondary).disabled(true)
    }
    .padding()
    .background(Palette.background)
}
