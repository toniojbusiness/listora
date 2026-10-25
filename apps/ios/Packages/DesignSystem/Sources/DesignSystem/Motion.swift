import SwiftUI

/// Listora's animations: short springs that settle without bouncing. With Reduce Motion on, they
/// become a quick fade, or nothing for movement-only changes.
public enum Motion {
    /// Most state changes: content appearing, a row updating.
    public static let standard = Animation.spring(response: 0.35, dampingFraction: 0.86)
    /// Direct feedback: a button press, a chip selection.
    public static let snappy = Animation.spring(response: 0.25, dampingFraction: 0.9)
    /// Larger moves: a photo changing place, a card expanding.
    public static let gentle = Animation.spring(response: 0.5, dampingFraction: 0.85)
    /// What every animation becomes with Reduce Motion on.
    public static let reduced = Animation.easeInOut(duration: 0.15)

    /// `animation`, or the Reduce Motion fallback.
    public static func animation(_ animation: Animation, reduceMotion: Bool) -> Animation {
        reduceMotion ? reduced : animation
    }

    /// Runs `body` with `animation`, or the Reduce Motion fallback when the user asked for less
    /// motion.
    @MainActor
    public static func perform(_ animation: Animation = standard, _ body: () -> Void) {
        withAnimation(UIAccessibility.isReduceMotionEnabled ? reduced : animation, body)
    }
}

struct MotionModifier<Value: Equatable>: ViewModifier {
    let animation: Animation
    let value: Value
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content.animation(Motion.animation(animation, reduceMotion: reduceMotion), value: value)
    }
}

extension View {
    /// Animates changes to `value` with `animation`, respecting Reduce Motion.
    public func motion(_ animation: Animation = Motion.standard, value: some Equatable) -> some View {
        modifier(MotionModifier(animation: animation, value: value))
    }
}

extension AnyTransition {
    /// Content entering from below and fading, for banners, toasts, and new rows. With Reduce Motion
    /// on, SwiftUI keeps only the fade.
    public static var rise: AnyTransition {
        .asymmetric(
            insertion: .move(edge: .bottom).combined(with: .opacity),
            removal: .opacity,
        )
    }
}
