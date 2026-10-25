import SwiftUI

/// A server-rendered status (`Active (you confirmed)`, `Delist failed - Retry`) with an icon and
/// color for its tone. The label is shown exactly as given; the tone only styles it.
public struct StatusLabel: View {
    /// How to style a status. Only `success` looks done, and it is used only for states an API
    /// read-back or the user confirmed.
    public enum Tone: Equatable, Sendable {
        case success
        case inProgress
        case checking
        case failed
        case actionNeeded
        case neutral

        var systemImage: String {
            switch self {
            case .success: "checkmark.circle.fill"
            case .inProgress: "arrow.triangle.2.circlepath"
            case .checking: "magnifyingglass"
            case .failed: "exclamationmark.octagon.fill"
            case .actionNeeded: "hand.point.right.fill"
            case .neutral: "circle"
            }
        }

        var color: ColorToken {
            switch self {
            case .success: Palette.success
            case .failed: Palette.danger
            case .actionNeeded: Palette.warning
            case .inProgress, .checking, .neutral: Palette.textSecondary
            }
        }
    }

    private let label: String
    private let tone: Tone

    public init(_ label: String, tone: Tone) {
        self.label = label
        self.tone = tone
    }

    public var body: some View {
        Label {
            Text(label)
                .foregroundStyle(tone.color)
        } icon: {
            Image(systemName: tone.systemImage)
                .foregroundStyle(tone.color)
        }
        .font(Typography.callout)
        // VoiceOver reads the status once, as given; the icon only repeats the tone.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }
}

#Preview {
    VStack(alignment: .leading, spacing: Spacing.sm) {
        StatusLabel("Active (confirmed by eBay)", tone: .success)
        StatusLabel("Active (you confirmed)", tone: .success)
        StatusLabel("Delisting... retry 2 of 6", tone: .inProgress)
        StatusLabel("Checking...", tone: .checking)
        StatusLabel("Delist failed - Retry", tone: .failed)
        StatusLabel("Action needed - delist on Poshmark", tone: .actionNeeded)
        StatusLabel("Draft", tone: .neutral)
    }
    .padding()
    .background(Palette.background)
}
