import SwiftUI

/// The main call-to-action button: full width, brand filled, and dimmed while pressed or
/// disabled.
public struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typography.headline)
            .foregroundStyle(Palette.onBrand)
            .frame(maxWidth: .infinity, minHeight: Layout.buttonHeight)
            .padding(.horizontal, Spacing.md)
            .background(Palette.brand, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.4)
            .contentShape(Rectangle())
    }
}

extension ButtonStyle where Self == PrimaryButtonStyle {
    public static var listoraPrimary: PrimaryButtonStyle {
        PrimaryButtonStyle()
    }
}

#Preview {
    VStack(spacing: Spacing.md) {
        Button("Add item") {}
        Button("Publish") {}.disabled(true)
    }
    .buttonStyle(.listoraPrimary)
    .padding()
}
