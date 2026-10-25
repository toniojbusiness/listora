import SwiftUI

/// How a card separates itself from the screen.
public enum CardKind: Sendable {
    /// A raised surface with a soft shadow and a hairline border: the default.
    case elevated
    /// A flat surface with a hairline border, for cards inside lists or stacked densely.
    case outlined
    /// A soft status-colored surface, for a card that is about that status.
    case tinted(StatusTone)
}

/// Groups related content on a raised surface.
struct CardModifier: ViewModifier {
    let kind: CardKind
    let padding: CGFloat

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.large, style: .continuous)
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(background, in: shape)
            .overlay(shape.strokeBorder(border, lineWidth: 1))
            .elevation(isElevated ? .low : .none)
    }

    private var isElevated: Bool {
        if case .elevated = kind {
            true
        } else {
            false
        }
    }

    private var background: ColorToken {
        switch kind {
        case .elevated, .outlined: Palette.surface
        case let .tinted(tone): tone.softColor
        }
    }

    private var border: AnyShapeStyle {
        switch kind {
        case .elevated, .outlined: AnyShapeStyle(Palette.separator)
        case let .tinted(tone): AnyShapeStyle(tone.color.color.opacity(0.25))
        }
    }
}

extension View {
    /// Puts the view on a card: a rounded surface with ``Spacing/md`` padding.
    public func cardStyle(_ kind: CardKind = .elevated, padding: CGFloat = Spacing.md) -> some View {
        modifier(CardModifier(kind: kind, padding: padding))
    }
}

#Preview {
    VStack(spacing: Spacing.md) {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text("Levi's 501 jeans").font(Typography.headline).foregroundStyle(Palette.textPrimary)
            Text("$48.00").font(Typography.price).foregroundStyle(Palette.brand)
        }
        .cardStyle()
        Text("Outlined").cardStyle(.outlined)
        Text("Upload failed").foregroundStyle(Palette.danger).cardStyle(.tinted(.failed))
    }
    .padding()
    .background(Palette.background)
}
