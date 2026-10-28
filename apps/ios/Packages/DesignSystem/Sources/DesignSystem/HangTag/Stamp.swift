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

#Preview {
    HStack(spacing: Spacing.sm) {
        Stamp("Urgent")
        Stamp("Soon", tone: .neutral)
        Stamp("Sold", angle: .degrees(-8))
        Stamp("Failed", tone: .failed)
    }
    .padding()
    .background(Palette.surface)
}
