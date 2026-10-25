import SwiftUI

/// A gray placeholder in the shape of content that is loading, with a soft shimmer (a slow pulse
/// with Reduce Motion on). VoiceOver reads the group's label once instead of each block.
public struct SkeletonBlock: View {
    private let width: CGFloat?
    private let height: CGFloat
    private let cornerRadius: CGFloat

    public init(width: CGFloat? = nil, height: CGFloat = 14, cornerRadius: CGFloat = Radius.small / 2) {
        self.width = width
        self.height = height
        self.cornerRadius = cornerRadius
    }

    public var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(Palette.surfaceSecondary)
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
            .shimmering()
            .accessibilityHidden(true)
    }
}

/// A list row that is loading: an icon square and two lines of text.
public struct SkeletonRow: View {
    public init() {}

    public var body: some View {
        HStack(spacing: Spacing.sm) {
            SkeletonBlock(width: 48, height: 48, cornerRadius: Radius.small)
            VStack(alignment: .leading, spacing: Spacing.xs) {
                SkeletonBlock(width: 140, height: 16)
                SkeletonBlock(height: 12)
                SkeletonBlock(width: 96, height: 12)
            }
        }
        .padding(.vertical, Spacing.xxs)
    }
}

struct ShimmerModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -1

    func body(content: Content) -> some View {
        content
            .overlay {
                if !reduceMotion {
                    GeometryReader { geometry in
                        LinearGradient(
                            colors: [.clear, Palette.surface.color.opacity(0.55), .clear],
                            startPoint: .leading,
                            endPoint: .trailing,
                        )
                        .frame(width: geometry.size.width * 0.6)
                        .offset(x: phase * geometry.size.width * 1.6)
                    }
                    .mask(content)
                }
            }
            .opacity(reduceMotion ? (phase > 0 ? 0.6 : 1) : 1)
            .onAppear {
                withAnimation(
                    reduceMotion
                        ? .easeInOut(duration: 1.2).repeatForever(autoreverses: true)
                        : .linear(duration: 1.3).repeatForever(autoreverses: false),
                ) {
                    phase = 1
                }
            }
    }
}

extension View {
    /// The skeleton's loading shimmer.
    public func shimmering() -> some View {
        modifier(ShimmerModifier())
    }
}

#Preview {
    VStack(spacing: Spacing.md) {
        SkeletonRow().cardStyle()
        SkeletonRow().cardStyle()
    }
    .padding()
    .background(Palette.background)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Loading")
}
