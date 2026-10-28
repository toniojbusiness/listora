import SwiftUI

/// A screen with nothing to show yet: an empty tag hanging from a rail, off to one side, then,
/// left-aligned under it like a printed card, a title, a short message, optional numbered steps
/// that explain what happens next, and one clear action, so a screen is never a dead end.
public struct EmptyStateView: View {
    public struct Action {
        let title: String
        let systemImage: String?
        let handler: @MainActor () -> Void

        public init(_ title: String, systemImage: String? = nil, handler: @escaping @MainActor () -> Void) {
            self.title = title
            self.systemImage = systemImage
            self.handler = handler
        }
    }

    private let systemImage: String
    private let tone: StatusTone?
    private let title: String
    private let message: String
    private let steps: [String]
    private let action: Action?

    public init(
        systemImage: String,
        tone: StatusTone? = nil,
        title: String,
        message: String,
        steps: [String] = [],
        action: Action? = nil,
    ) {
        self.systemImage = systemImage
        self.tone = tone
        self.title = title
        self.message = message
        self.steps = steps
        self.action = action
    }

    public var body: some View {
        // Centered when it fits; scrolls from the top when large text makes it taller than the screen.
        GeometryReader { geometry in
            ScrollView {
                content
                    .frame(maxWidth: .infinity, minHeight: geometry.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(Palette.background)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            art
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text(title)
                    .font(Typography.title)
                    .foregroundStyle(Palette.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(message)
                    .font(Typography.body)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .multilineTextAlignment(.leading)
            if !steps.isEmpty {
                stepList
            }
            if let action {
                button(action)
                    .buttonStyle(.listoraPrimary)
                    .padding(.top, Spacing.xs)
            }
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, Spacing.xl)
        .frame(maxWidth: 440, alignment: .leading)
    }

    /// The rail runs in from the screen's leading edge, and the tag hangs from it off center, so
    /// the art and the text do not stack on one centered axis.
    private var art: some View {
        SpotIllustration(systemImage: systemImage, tone: tone)
            .padding(.trailing, Spacing.lg)
            .frame(maxWidth: .infinity, alignment: .trailing)
            .background(alignment: .top) {
                Capsule()
                    .fill(Palette.rail)
                    .frame(height: 3)
                    .padding(.leading, -Spacing.lg)
                    .accessibilityHidden(true)
            }
    }

    private var stepList: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                    Text("\(index + 1)")
                        .font(Typography.label)
                        .foregroundStyle(Palette.brand)
                        .frame(minWidth: 28, minHeight: 28)
                        .background(
                            Palette.brandSoft,
                            in: RoundedRectangle(cornerRadius: Radius.tight, style: .continuous),
                        )
                        .accessibilityHidden(true)
                    Text(step)
                        .font(Typography.callout)
                        .foregroundStyle(Palette.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Step \(index + 1): \(step)")
            }
        }
    }

    private func button(_ action: Action) -> some View {
        Button(action: action.handler) {
            if let systemImage = action.systemImage {
                Label(action.title, systemImage: systemImage)
            } else {
                Text(action.title)
            }
        }
    }
}

#Preview("Light") {
    EmptyStateView(
        systemImage: "hanger",
        title: "No items yet",
        message: "Create an item once, and Listora keeps it in sync everywhere you sell.",
        steps: ["Take photos of the item", "Check the details Listora fills in", "List it on your marketplaces"],
        action: .init("Add item", systemImage: "plus") {},
    )
}

#Preview("Dark") {
    EmptyStateView(
        systemImage: "checklist",
        title: "You're all caught up",
        message: "Marketplace steps that need you will show up here.",
    )
    .preferredColorScheme(.dark)
}
