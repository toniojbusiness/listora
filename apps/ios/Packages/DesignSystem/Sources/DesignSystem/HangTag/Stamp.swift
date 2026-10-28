import SwiftUI

/// A rubber-stamp mark: one short word in inked capitals inside a ruled box, such as how urgent a
/// card is ("Urgent", "Soon"). It replaces a pill where the word is a mark on the tag rather than
/// a status: statuses in the honest vocabulary stay ``StatusBadge`` or ``StatusLabel``. The word
/// is shown as given (in capitals) and read by VoiceOver as given.
public struct Stamp: View {
    private let text: String
    private let tone: StatusTone?
    private let angle: Angle

    /// `tone` inks the stamp; nil uses the brand clay. `angle` tilts it, as a hand-pressed stamp.
    public init(_ text: String, tone: StatusTone? = nil, angle: Angle = .zero) {
        self.text = text
        self.tone = tone
        self.angle = angle
    }

    private var ink: ColorToken {
        switch tone {
        case nil: Palette.brand
        case .neutral: Palette.textPrimary
        case let tone?: tone.color
        }
    }

    public var body: some View {
        Text(text)
            .font(Typography.stamp)
            .textCase(.uppercase)
            .tracking(1.4)
            .foregroundStyle(ink)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, Spacing.xs - 2)
            .padding(.vertical, 3)
            .overlay {
                RoundedRectangle(cornerRadius: Radius.tight, style: .continuous)
                    .strokeBorder(ink, lineWidth: 1.5)
            }
            .rotationEffect(angle)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(text)
    }
}

/// A symbol (or a letter or two) stamped in ink inside a ruled square, a little crooked like a
/// hand-pressed stamp: the mark of a card that has no item photo (reconnect a marketplace, drafts
/// to review), and what ``IconTile`` draws at card and hero sizes. It takes the place of an icon
/// on a soft tile, so a card reads as a tag with a mark on it, not a row with an icon.
/// Decorative, so VoiceOver skips it.
public struct StampMark: View {
    enum Mark {
        case symbol(String)
        case monogram(String)
    }

    private let mark: Mark
    private let tone: StatusTone?
    private let side: CGFloat
    private let scales: Bool
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    /// The mark's side at the default text size, the size of a card's item photo.
    public static let side: CGFloat = 56

    /// `tone` inks the mark; nil uses the brand clay.
    public init(systemImage: String, tone: StatusTone? = nil) {
        self.init(.symbol(systemImage), tone: tone, side: Self.side, scales: true)
    }

    /// A mark of `side` points that grows with the text (up to 1.4 times) when `scales`.
    init(_ mark: Mark, tone: StatusTone?, side: CGFloat, scales: Bool) {
        self.mark = mark
        self.tone = tone
        self.side = side
        self.scales = scales
    }

    private var ink: ColorToken {
        switch tone {
        case nil: Palette.brand
        case .neutral: Palette.textPrimary
        case let tone?: tone.color
        }
    }

    public var body: some View {
        let side = scales ? side * min(max(scale, 1), 1.4) : side
        Group {
            switch mark {
            case let .symbol(name):
                Image(systemName: name)
                    .font(.system(size: side * 0.42, weight: .bold))
            case let .monogram(letters):
                Text(letters)
                    .font(.system(size: side * 0.46, weight: .heavy))
            }
        }
        .foregroundStyle(ink)
        .frame(width: side, height: side)
        .overlay {
            RoundedRectangle(cornerRadius: Radius.tight, style: .continuous)
                .strokeBorder(ink, lineWidth: side > 80 ? 3 : 2)
                .padding(side > 80 ? 5 : 3)
        }
        .rotationEffect(.degrees(-4))
        .accessibilityHidden(true)
    }
}

#Preview {
    HStack(spacing: Spacing.sm) {
        Stamp("Urgent")
        Stamp("Soon", tone: .neutral)
        Stamp("Sold", angle: .degrees(-8))
        Stamp("Failed", tone: .failed)
        StampMark(systemImage: "link", tone: .actionNeeded)
    }
    .padding()
    .background(Palette.surface)
}
