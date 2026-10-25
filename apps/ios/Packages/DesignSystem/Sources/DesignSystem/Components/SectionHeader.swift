import SwiftUI

/// A heading above a group of content: a short title in small capitals, an optional line of
/// explanation, and an optional trailing action. VoiceOver treats the title as a header.
public struct SectionHeader: View {
    public struct Action {
        let title: String
        let handler: @MainActor () -> Void

        public init(_ title: String, handler: @escaping @MainActor () -> Void) {
            self.title = title
            self.handler = handler
        }
    }

    private let title: String
    private let subtitle: String?
    private let action: Action?

    public init(_ title: String, subtitle: String? = nil, action: Action? = nil) {
        self.title = title
        self.subtitle = subtitle
        self.action = action
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(Typography.eyebrow)
                    .textCase(.uppercase)
                    .tracking(0.6)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: Spacing.xs)
                if let action {
                    Button(action.title, action: action.handler)
                        .font(Typography.subheadline.weight(.semibold))
                        .foregroundStyle(Palette.brand)
                        .frame(minHeight: Layout.minimumTapTarget)
                }
            }
            if let subtitle {
                Text(subtitle)
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

#Preview {
    VStack(spacing: Spacing.lg) {
        SectionHeader("Drafts", action: .init("Select") {})
        SectionHeader("Marketplaces", subtitle: "Connected marketplaces are checked after every change.")
    }
    .padding()
    .background(Palette.background)
}
