import DesignSystem
import SwiftUI

/// A titled card of related rows.
struct SectionCard<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text(title)
                .font(Typography.headline)
                .foregroundStyle(Palette.textPrimary)
                .accessibilityAddTraits(.isHeader)
            content
        }
        .cardStyle()
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
                .font(Typography.callout)
                .foregroundStyle(Palette.textSecondary)
            Spacer(minLength: Spacing.sm)
            VStack(alignment: .trailing, spacing: 2) {
                Text(value)
                    .font(Typography.callout.weight(.semibold).monospacedDigit())
                    .foregroundStyle(Palette.textPrimary)
                    .multilineTextAlignment(.trailing)
                if let note {
                    Text(note)
                        .font(Typography.caption)
                        .foregroundStyle(Palette.textSecondary)
                        .multilineTextAlignment(.trailing)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A failure to reach the server, with a way to dismiss it.
struct NoticeBanner: View {
    let message: String
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Palette.danger)
                .accessibilityHidden(true)
            Text(message)
                .font(Typography.callout)
                .foregroundStyle(Palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("item.notice")
            Spacer(minLength: 0)
            Button("Dismiss", systemImage: "xmark", action: dismiss)
                .labelStyle(.iconOnly)
                .foregroundStyle(Palette.textSecondary)
                .frame(minWidth: Layout.minimumTapTarget, minHeight: Layout.minimumTapTarget)
                .buttonStyle(.borderless)
        }
        .cardStyle()
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
                AsyncImage(url: url.flatMap(URL.init(string:))) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        Image(systemName: "photo")
                            .font(.system(size: 22))
                            .foregroundStyle(Palette.textSecondary)
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .accessibilityHidden(url == nil)
    }
}
