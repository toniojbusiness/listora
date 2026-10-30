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

/// A photo grid cell that is loading: a square photo, then a title and a price line, shaped like
/// the inventory's grid cell.
public struct SkeletonPhotoTile: View {
    public init() {}

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            RoundedRectangle(cornerRadius: Radius.large, style: .continuous)
                .fill(Palette.surfaceSecondary)
                .aspectRatio(1, contentMode: .fit)
                .shimmering()
            SkeletonBlock(height: 14)
                .padding(.trailing, Spacing.lg)
            SkeletonBlock(width: 64, height: 14)
        }
        .accessibilityHidden(true)
    }
}

/// A screen of content that is loading: `count` placeholders made by `placeholder`, stacked as
/// the loaded screen stacks its rows, read by VoiceOver once as `label`. Scrolling is off, since
/// there is nothing to scroll to yet.
public struct SkeletonList<Placeholder: View>: View {
    private let count: Int
    private let label: String
    private let placeholder: () -> Placeholder

    public init(count: Int = 5, label: String, @ViewBuilder placeholder: @escaping () -> Placeholder) {
        self.count = count
        self.label = label
        self.placeholder = placeholder
    }

    public var body: some View {
        ScrollView {
            VStack(spacing: Spacing.md) {
                ForEach(0 ..< count, id: \.self) { _ in
                    placeholder()
                }
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
        }
        .scrollDisabled(true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }
}

extension SkeletonList where Placeholder == AnyView {
    /// Rows shaped like ``ListRow``s on cards: most lists.
    public init(count: Int = 5, label: String) {
        self.init(count: count, label: label) { AnyView(SkeletonRow().cardStyle(.flat)) }
    }
}

/// The shimmer is drawn from the clock (`TimelineView`) rather than with a `repeatForever`
/// animation: such an animation never completes, and it kept running after its view was gone (a
/// closed photo sheet), so UI tests waiting for the app to be idle waited out their full minute.
/// A timeline draws only while its view is on screen.
struct ShimmerModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// One sweep of the highlight, left to right.
    nonisolated static let sweep: TimeInterval = 1.3
    /// One fade of the Reduce Motion pulse, from full to dimmed or back.
    nonisolated static let pulse: TimeInterval = 1.2

    func body(content: Content) -> some View {
        TimelineView(.animation) { timeline in
            let time = timeline.date.timeIntervalSinceReferenceDate
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
                            .offset(x: Self.sweepPhase(at: time) * geometry.size.width * 1.6)
                        }
                        .mask(content)
                    }
                }
                .opacity(reduceMotion ? Self.pulseOpacity(at: time) : 1)
        }
    }

    /// Where the highlight is, from -1 (off the leading edge) to 1, restarting every sweep.
    nonisolated static func sweepPhase(at time: TimeInterval) -> CGFloat {
        -1 + 2 * CGFloat(time.truncatingRemainder(dividingBy: sweep) / sweep)
    }

    /// The Reduce Motion pulse: 1 to 0.6 and back, eased in and out.
    nonisolated static func pulseOpacity(at time: TimeInterval) -> Double {
        let position = time.truncatingRemainder(dividingBy: 2 * pulse) / pulse
        let fade = position <= 1 ? position : 2 - position
        let eased = fade * fade * (3 - 2 * fade)
        return 1 - 0.4 * eased
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
