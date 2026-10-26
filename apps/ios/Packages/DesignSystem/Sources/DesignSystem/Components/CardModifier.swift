import SwiftUI

/// How a card separates itself from the screen.
public enum CardKind: Sendable {
    /// A raised surface with a soft shadow: the default, for a screen's main groups.
    case elevated
    /// A flat surface with no shadow, for cards stacked densely or inside lists.
    case flat
    /// A soft status-colored surface, for a card that is about that status.
    case tinted(StatusTone)
}

/// Groups related content on a surface. Light mode separates cards from the screen by their
/// lighter surface and, for `elevated`, a soft shadow, with no border; dark mode, where shadows
/// barely show, adds a faint hairline.
struct CardModifier: ViewModifier {
    let kind: CardKind
    let padding: CGFloat
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.large, style: .continuous)
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(background, in: shape)
            .overlay {
                if let border {
                    shape.strokeBorder(border, lineWidth: 1)
                }
            }
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
        case .elevated, .flat: Palette.surface
        case let .tinted(tone): tone.softColor
        }
    }

    /// Whether a card of `kind` draws a hairline border in `colorScheme`.
    static func hasBorder(_ kind: CardKind, in colorScheme: ColorScheme) -> Bool {
        switch kind {
        case .elevated, .flat: colorScheme == .dark
        case .tinted: true
        }
    }

    private var border: AnyShapeStyle? {
        guard Self.hasBorder(kind, in: colorScheme) else { return nil }
        switch kind {
        case .elevated, .flat:
            return AnyShapeStyle(Palette.separator.color.opacity(0.7))
        case let .tinted(tone):
            return AnyShapeStyle(tone.color.color.opacity(colorScheme == .dark ? 0.3 : 0.18))
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
        Text("Flat").cardStyle(.flat)
        Text("Upload failed").foregroundStyle(Palette.danger).cardStyle(.tinted(.failed))
    }
    .padding()
    .background(Palette.background)
}
