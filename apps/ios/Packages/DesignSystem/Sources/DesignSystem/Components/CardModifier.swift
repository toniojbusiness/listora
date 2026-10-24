import SwiftUI

/// Groups related content on a raised surface with a hairline border.
struct CardModifier: ViewModifier {
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.large, style: .continuous)
        content
            .padding(Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.surface, in: shape)
            .overlay(shape.strokeBorder(Palette.separator, lineWidth: 1))
    }
}

extension View {
    public func cardStyle() -> some View {
        modifier(CardModifier())
    }
}

#Preview {
    VStack(alignment: .leading, spacing: Spacing.xs) {
        Text("Levi's 501 jeans").font(Typography.headline).foregroundStyle(Palette.textPrimary)
        Text("$48.00").font(Typography.price).foregroundStyle(Palette.brand)
    }
    .cardStyle()
    .padding()
    .background(Palette.background)
}
