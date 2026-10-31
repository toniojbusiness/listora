import CoreHaptics
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
        /// Two short taps: a scan's call is Buy, felt without looking at the screen.
        case doubleTap
        /// One long buzz: a scan's call is Skip.
        case longBuzz
    }

    /// Plays the long buzz; created on first use, nil on hardware without Core Haptics.
    private static var engine: CHHapticEngine?

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
        case .doubleTap:
            let generator = UIImpactFeedbackGenerator(style: .medium)
            generator.impactOccurred()
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(120))
                generator.impactOccurred()
            }
        case .longBuzz:
            playLongBuzz()
        }
    }

    /// A continuous half-second buzz through Core Haptics, or a heavy tap where it is missing.
    private static func playLongBuzz() {
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else {
            UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
            return
        }
        do {
            let engine = try engine ?? CHHapticEngine()
            engine.isAutoShutdownEnabled = true
            Self.engine = engine
            try engine.start()
            let buzz = CHHapticEvent(
                eventType: .hapticContinuous,
                parameters: [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.8),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.3),
                ],
                relativeTime: 0,
                duration: 0.5,
            )
            try engine.makePlayer(with: CHHapticPattern(events: [buzz], parameters: [])).start(atTime: 0)
        } catch {
            UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        }
    }
}
