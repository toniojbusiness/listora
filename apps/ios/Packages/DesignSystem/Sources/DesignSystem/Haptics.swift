import UIKit

/// Haptic feedback for key moments, played through UIKit's feedback generators, which follow the
/// user's system haptics setting. Views that can, use SwiftUI's `sensoryFeedback` instead; this is
/// for actions started in code (the camera shutter, an upload finishing).
@MainActor
public enum Haptics {
    public enum Event: Sendable {
        /// A photo was taken, a chip was picked.
        case tap
        /// A selection changed.
        case selection
        /// Something was confirmed: an account connected, a draft saved.
        case success
        /// Something needs attention: a blurry photo.
        case warning
        /// Something failed.
        case failure
    }

    public static func play(_ event: Event) {
        switch event {
        case .tap:
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .selection:
            UISelectionFeedbackGenerator().selectionChanged()
        case .success:
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .warning:
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case .failure:
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }
}
