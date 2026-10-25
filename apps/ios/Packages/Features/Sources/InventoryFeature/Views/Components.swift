import DesignSystem
import SwiftUI

/// A group on the item screen: a section header above a card of related rows.
struct DetailSection<Content: View>: View {
    let title: String
    var subtitle: String?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader(title, subtitle: subtitle)
            VStack(alignment: .leading, spacing: Spacing.sm) {
                content
            }
            .cardStyle()
        }
    }
}

/// "Cost  $8.00", with an optional note under the value.
struct LabeledRow: View {
    let label: String
    let value: String
    let note: String?

    init(_ label: String, value: String, note: String? = nil) {
        self.label = label
        self.value = value
        self.note = note
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
            Text(label)
                .font(Typography.subheadline)
                .foregroundStyle(Palette.textSecondary)
            Spacer(minLength: Spacing.sm)
            VStack(alignment: .trailing, spacing: 2) {
                Text(value)
                    .font(Typography.subheadline.weight(.semibold).monospacedDigit())
                    .foregroundStyle(Palette.textPrimary)
                    .multilineTextAlignment(.trailing)
                if let note {
                    Text(note)
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                        .multilineTextAlignment(.trailing)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A photo from its URL, filling the space it is given, with a placeholder while it loads or
/// when there is none.
struct PhotoView: View {
    let url: String?
    let cornerRadius: CGFloat

    var body: some View {
        // The color takes exactly the proposed size; the photo fills it and is clipped to it.
        Palette.surfaceSecondary.color
            .overlay {
                RemoteImage(url: url.flatMap(URL.init(string:))) {
                    Image(systemName: "photo")
                        .font(Typography.title3)
                        .foregroundStyle(Palette.textSecondary)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .accessibilityHidden(url == nil)
    }
}
