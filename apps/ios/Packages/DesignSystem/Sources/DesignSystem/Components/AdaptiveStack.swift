import SwiftUI

/// Side by side at regular text sizes, stacked at accessibility sizes, so a pair of buttons keeps
/// whole labels at any text size.
public struct AdaptiveStack<Content: View>: View {
    private let spacing: CGFloat
    private let content: Content
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    public init(spacing: CGFloat = Spacing.sm, @ViewBuilder content: () -> Content) {
        self.spacing = spacing
        self.content = content()
    }

    public var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(spacing: spacing))
            : AnyLayout(HStackLayout(spacing: spacing))
        layout { content }
    }
}
