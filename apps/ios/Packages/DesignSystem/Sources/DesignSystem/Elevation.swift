import SwiftUI

/// How far an element floats above the screen. Cards sit `low`; bars pinned over scrolling content
/// sit `medium`; toasts sit `high`. In light mode the shadow alone lifts a card (cards have no border); in dark mode
/// shadows are faint, and hairline borders on the lighter surfaces carry the separation.
public enum Elevation: Sendable {
    case none
    case low
    case medium
    case high

    var radius: CGFloat {
        switch self {
        case .none: 0
        case .low: 14
        case .medium: 16
        case .high: 24
        }
    }

    var y: CGFloat {
        switch self {
        case .none: 0
        case .low: 4
        case .medium: 6
        case .high: 10
        }
    }

    func opacity(for colorScheme: ColorScheme) -> Double {
        switch self {
        case .none: 0
        case .low: colorScheme == .dark ? 0.35 : 0.07
        case .medium: colorScheme == .dark ? 0.45 : 0.10
        case .high: colorScheme == .dark ? 0.55 : 0.16
        }
    }
}

struct ElevationModifier: ViewModifier {
    let elevation: Elevation
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content.shadow(
            color: Palette.shadow.color.opacity(elevation.opacity(for: colorScheme)),
            radius: elevation.radius,
            y: elevation.y,
        )
    }
}

extension View {
    /// Lifts the view by `elevation` with a soft shadow.
    public func elevation(_ elevation: Elevation) -> some View {
        modifier(ElevationModifier(elevation: elevation))
    }
}
