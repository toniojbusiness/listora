import SwiftUI

/// How a status is styled, in the API's honest vocabulary (`StatusTone` in the contract). Only
/// `success` looks done, and it is used only for states an API read-back or the user confirmed.
/// Everything else says plainly that work is running, being checked, failed, or needs the user.
public enum StatusTone: Equatable, Sendable, CaseIterable {
    /// Confirmed: read back from the marketplace, or confirmed by the user.
    case success
    /// Work is running (uploading, delisting).
    case inProgress
    /// Listora is reading the result back, or rechecking a connection.
    case checking
    /// The step failed; the user can retry.
    case failed
    /// Only the user can move this on (reconnect, finish an assisted step).
    case actionNeeded
    /// No status to call out (draft, not connected, assisted).
    case neutral

    /// The strong color, for text and icons.
    public var color: ColorToken {
        switch self {
        case .success: Palette.success
        case .inProgress, .checking: Palette.info
        case .failed: Palette.danger
        case .actionNeeded: Palette.warning
        case .neutral: Palette.textSecondary
        }
    }

    /// The soft color, for badge and banner backgrounds.
    public var softColor: ColorToken {
        switch self {
        case .success: Palette.successSoft
        case .inProgress, .checking: Palette.infoSoft
        case .failed: Palette.dangerSoft
        case .actionNeeded: Palette.warningSoft
        case .neutral: Palette.surfaceSecondary
        }
    }

    public var systemImage: String {
        switch self {
        case .success: "checkmark.circle.fill"
        case .inProgress: "arrow.triangle.2.circlepath"
        case .checking: "magnifyingglass"
        case .failed: "exclamationmark.octagon.fill"
        case .actionNeeded: "exclamationmark.triangle.fill"
        case .neutral: "circle.dashed"
        }
    }

    /// True only for confirmed states.
    public var looksDone: Bool {
        self == .success
    }
}
