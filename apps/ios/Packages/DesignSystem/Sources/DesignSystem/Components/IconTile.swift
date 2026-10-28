import SwiftUI

/// An SF Symbol or a monogram as a mark. At row size it sits on a soft rounded square, the
/// leading icon of a list row (Settings); at card and hero sizes it is stamped in ink
/// (``StampMark``), so cards read as tags with a mark on them rather than rows of icon tiles.
/// Decorative, so VoiceOver skips it.
public struct IconTile: View {
    public enum Size: Sendable {
        /// 36 points, for list rows.
        case row
        /// 48 points, for cards.
        case card
        /// 96 points, for empty states.
        case hero

        var side: CGFloat {
            switch self {
            case .row: 36
            case .card: 48
            case .hero: 96
            }
        }

        var font: Font {
            switch self {
            case .row: .body.weight(.semibold)
            case .card: .title3.weight(.semibold)
            case .hero: .system(size: 40, weight: .semibold)
            }
        }
    }

    private let content: Content
    private let tone: StatusTone?
    private let size: Size
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    private enum Content {
        case symbol(String)
        case monogram(String)
    }

    /// `tone` colors the tile; nil uses the brand.
    public init(systemImage: String, tone: StatusTone? = nil, size: Size = .row) {
        content = .symbol(systemImage)
        self.tone = tone
        self.size = size
    }

    /// A tile with one or two letters, such as a marketplace's initial.
    public init(monogram: String, tone: StatusTone? = nil, size: Size = .row) {
        content = .monogram(monogram)
        self.tone = tone
        self.size = size
    }

    public var body: some View {
        if size == .row {
            tile
        } else {
            switch content {
            case let .symbol(name):
                StampMark(.symbol(name), tone: tone, side: size.side, scales: size == .card)
            case let .monogram(letters):
                StampMark(.monogram(letters), tone: tone, side: size.side, scales: size == .card)
            }
        }
    }

    private var tile: some View {
        let side = size.side * min(scale, 1.6)
        return Group {
            switch content {
            case let .symbol(name):
                Image(systemName: name)
            case let .monogram(letters):
                Text(letters)
            }
        }
        .font(size.font)
        .foregroundStyle(tone?.color ?? Palette.brand)
        .frame(width: side, height: side)
        .background(
            tone?.softColor ?? Palette.brandSoft,
            in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous),
        )
        .accessibilityHidden(true)
    }
}

#Preview {
    HStack(spacing: Spacing.md) {
        IconTile(systemImage: "link")
        IconTile(monogram: "e", size: .card)
        IconTile(systemImage: "checkmark", tone: .success, size: .card)
        IconTile(systemImage: "shippingbox", size: .hero)
    }
    .padding()
    .background(Palette.background)
}
