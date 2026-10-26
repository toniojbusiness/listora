import SwiftUI

/// The friendly art of an empty screen, drawn from palette colors and an SF Symbol, so it suits
/// both modes and every screen without image assets: two tilted cards on a soft circle, the front
/// one carrying the symbol, with a few small shapes around them. Decorative, so VoiceOver skips
/// it. It settles in with a short spring (a fade with Reduce Motion on).
public struct SpotIllustration: View {
    private let systemImage: String
    private let tone: StatusTone?
    @State private var isShown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The artwork's side, in points; it does not grow with the text size, so the title and the
    /// action stay on screen at the largest sizes.
    public static let side: CGFloat = 168

    /// `tone` colors the art; nil uses the brand.
    public init(systemImage: String, tone: StatusTone? = nil) {
        self.systemImage = systemImage
        self.tone = tone
    }

    private var strong: ColorToken {
        tone?.color ?? Palette.brand
    }

    private var soft: ColorToken {
        tone?.softColor ?? Palette.brandSoft
    }

    public var body: some View {
        let side = Self.side
        ZStack {
            Circle()
                .fill(soft)
                .frame(width: side * 0.86, height: side * 0.86)
            Circle()
                .fill(Palette.surfaceSecondary)
                .frame(width: side * 0.2, height: side * 0.2)
                .offset(x: side * 0.36, y: -side * 0.3)
            Circle()
                .strokeBorder(strong.color.opacity(0.35), lineWidth: 2)
                .frame(width: side * 0.13, height: side * 0.13)
                .offset(x: -side * 0.4, y: side * 0.3)
            Image(systemName: "sparkle")
                .font(.system(size: side * 0.11, weight: .semibold))
                .foregroundStyle(strong.color.opacity(0.7))
                .offset(x: -side * 0.34, y: -side * 0.32)
            card(fill: Palette.surfaceSecondary)
                .rotationEffect(.degrees(isShown ? 9 : 0))
                .offset(x: side * 0.07, y: -side * 0.03)
            card(fill: Palette.surface)
                .overlay {
                    Image(systemName: systemImage)
                        .font(.system(size: side * 0.22, weight: .semibold))
                        .foregroundStyle(strong)
                }
                .rotationEffect(.degrees(isShown ? -5 : 0))
                .elevation(.medium)
        }
        .frame(width: side, height: side)
        .scaleEffect(isShown || reduceMotion ? 1 : 0.92)
        .opacity(isShown ? 1 : 0)
        .accessibilityHidden(true)
        .onAppear {
            withAnimation(Motion.animation(Motion.gentle, reduceMotion: reduceMotion)) {
                isShown = true
            }
        }
    }

    private func card(fill: ColorToken) -> some View {
        RoundedRectangle(cornerRadius: Radius.large, style: .continuous)
            .fill(fill)
            .frame(width: Self.side * 0.46, height: Self.side * 0.54)
    }
}

#Preview {
    HStack(spacing: Spacing.lg) {
        SpotIllustration(systemImage: "shippingbox")
        SpotIllustration(systemImage: "checkmark", tone: .success)
    }
    .padding()
    .background(Palette.background)
}
