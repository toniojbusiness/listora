import DesignSystem
import SwiftUI

/// The brief line over the live camera where the card was, after Keep or Put back: "Kept · 3 in
/// this run". It goes by itself; the camera is ready for the next shot the whole time.
struct ScanConfirmationView: View {
    let line: ScanConfirmationLine

    var body: some View {
        HStack(spacing: Spacing.xs) {
            if line.tone == .working {
                BrandSpinner(color: Palette.onMedia).controlSize(.small).accessibilityHidden(true)
            } else {
                Image(systemName: line.systemImage)
                    .foregroundStyle(iconColor)
            }
            Text(line.text)
                .font(Typography.headline)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, Spacing.sm)
        .background(Palette.scrim.color.opacity(0.7), in: Capsule())
        .padding(.horizontal, Spacing.md)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("scan.confirmation")
    }

    private var iconColor: Color {
        switch line.tone {
        case .working, .done: Palette.success.color
        case .failed: Palette.danger.color
        }
    }
}

extension View {
    /// Announces the line to VoiceOver, and once it settled, hides it after a moment (longer for a
    /// failure, so it is read).
    func goesAway(_ line: ScanConfirmationLine, _ hide: @escaping @MainActor () -> Void) -> some View {
        task(id: line) {
            AccessibilityNotification.Announcement(line.text).post()
            guard line.tone != .working else { return }
            let shown = line.tone == .failed ? ScanConfirmation.failureShownFor : ScanConfirmation.shownFor
            try? await Task.sleep(for: shown)
            guard !Task.isCancelled else { return }
            withAnimation(Motion.snappy) { hide() }
        }
    }
}
