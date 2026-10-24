import SwiftUI

/// A centered icon, title, message, and optional action for screens with nothing to show yet.
public struct EmptyStateView: View {
    public struct Action {
        let title: String
        let handler: @MainActor () -> Void

        public init(_ title: String, handler: @escaping @MainActor () -> Void) {
            self.title = title
            self.handler = handler
        }
    }

    private let systemImage: String
    private let title: String
    private let message: String
    private let action: Action?

    public init(systemImage: String, title: String, message: String, action: Action? = nil) {
        self.systemImage = systemImage
        self.title = title
        self.message = message
        self.action = action
    }

    public var body: some View {
        VStack(spacing: Spacing.md) {
            Image(systemName: systemImage)
                .font(.system(size: 44, weight: .regular))
                .foregroundStyle(Palette.brand)
                .frame(width: 88, height: 88)
                .background(Palette.surfaceSecondary, in: Circle())
                .accessibilityHidden(true)
            VStack(spacing: Spacing.xs) {
                Text(title)
                    .font(Typography.title)
                    .foregroundStyle(Palette.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                Text(message)
                    .font(Typography.body)
                    .foregroundStyle(Palette.textSecondary)
            }
            .multilineTextAlignment(.center)
            if let action {
                Button(action.title, action: action.handler)
                    .buttonStyle(.listoraPrimary)
                    .padding(.top, Spacing.xs)
            }
        }
        .padding(Spacing.lg)
        .frame(maxWidth: 420)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.background)
    }
}

#Preview("Light") {
    EmptyStateView(
        systemImage: "shippingbox",
        title: "No items yet",
        message: "Items you add appear here with their status on every marketplace.",
        action: .init("Add item") {},
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
