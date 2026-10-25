import SwiftUI

/// A bar pinned to the bottom of a screen that holds its main actions within thumb reach. Attach it
/// with ``SwiftUI/View/bottomActionBar(_:)`` so scrolling content stops above it. On a material
/// background with a hairline, so content scrolling underneath stays legible.
public struct BottomActionBar<Content: View>: View {
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        VStack(spacing: Spacing.sm) {
            content
        }
        .padding(.horizontal, Spacing.md)
        .padding(.top, Spacing.sm)
        .padding(.bottom, Spacing.xs)
        .frame(maxWidth: .infinity)
        .background(.bar)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(Palette.separator)
                .frame(height: 1 / 3)
        }
    }
}

extension View {
    /// Pins `content` in a ``BottomActionBar`` to the bottom safe area.
    public func bottomActionBar(@ViewBuilder _ content: () -> some View) -> some View {
        safeAreaInset(edge: .bottom, spacing: 0) {
            BottomActionBar(content: content)
        }
    }
}

#Preview {
    List(0 ..< 30) { index in
        Text("Draft \(index)")
    }
    .bottomActionBar {
        Button("Take photos", systemImage: "camera.fill") {}.buttonStyle(.listoraPrimary)
        Button("Import from library", systemImage: "photo.on.rectangle") {}.buttonStyle(.listoraTertiary)
    }
}
