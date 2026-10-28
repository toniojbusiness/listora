import SwiftUI

/// The art of an empty screen: an empty price tag hanging by its string, a little tilted, with an
/// SF Symbol printed on it and two blank lines to write on, drawn from palette colors so it suits
/// both modes and every screen without image assets. ``EmptyStateView`` hangs it from a rail.
/// Decorative, so VoiceOver skips it. It swings in and settles (a fade with Reduce Motion on).
public struct SpotIllustration: View {
    private let systemImage: String
    private let tone: StatusTone?
    @State private var isShown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The artwork's side, in points; it does not grow with the text size, so the title and the
    /// action stay on screen at the largest sizes.
    public static let side: CGFloat = 168

    /// How far the string drops from the rail to the tag's eyelet.
    static let stringLength: CGFloat = 34
    /// The tag's resting tilt, in degrees.
    static let restingTilt: Double = 6

    /// `tone` colors the symbol; nil uses the brand.
    public init(systemImage: String, tone: StatusTone? = nil) {
        self.systemImage = systemImage
        self.tone = tone
    }

    public var body: some View {
        let side = Self.side
        let tagSize = CGSize(width: side * 0.62, height: side * 0.8)
        VStack(spacing: 0) {
            ThreadSegment()
                .stroke(Palette.thread, style: Thread.stroke(.taut))
                .frame(width: Thread.width, height: Self.stringLength)
            tag(size: tagSize)
                // The string ties on through the eyelet, so the tag starts just above it.
                .padding(.top, -(TagMetrics.eyeletInset + 2))
        }
        .rotationEffect(.degrees(isShown || reduceMotion ? Self.restingTilt : 16), anchor: .top)
        .frame(width: side, height: side, alignment: .top)
        .opacity(isShown ? 1 : 0)
        .accessibilityHidden(true)
        .onAppear {
            withAnimation(Motion.animation(Motion.gentle, reduceMotion: reduceMotion)) {
                isShown = true
            }
        }
    }

    private func tag(size: CGSize) -> some View {
        TagShape(end: .top, chamfer: 26)
            .fill(Palette.surface)
            .stitchedEdge(TagShape(end: .top, chamfer: 26, punchesEyelet: false), inset: 5)
            .overlay(alignment: .top) {
                EyeletRing().padding(.top, TagMetrics.eyeletInset + 2 - TagMetrics.eyeletRingRadius)
            }
            .overlay {
                VStack(spacing: Spacing.sm) {
                    Image(systemName: systemImage)
                        .font(.system(size: size.width * 0.3, weight: .semibold))
                        .foregroundStyle(tone?.color ?? Palette.brand)
                    VStack(spacing: Spacing.xs) {
                        Capsule().fill(Palette.separator).frame(width: size.width * 0.56, height: 1.5)
                        Capsule().fill(Palette.separator).frame(width: size.width * 0.4, height: 1.5)
                    }
                }
                .padding(.top, Spacing.lg)
            }
            .frame(width: size.width, height: size.height)
            .elevation(.medium)
    }
}

#Preview {
    HStack(spacing: Spacing.lg) {
        SpotIllustration(systemImage: "dollarsign")
        SpotIllustration(systemImage: "checkmark", tone: .success)
    }
    .padding()
    .background(Palette.background)
}
