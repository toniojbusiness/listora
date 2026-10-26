import Foundation
import Observation

/// Whether to show the first-run guide (``GettingStartedView``): once, right after the seller
/// first signs in on this iPhone. A session that already exists when the app starts (an earlier
/// sign-in, or the UI tests' launch session) does not show it; signing in while the app runs
/// does, unless the guide was already shown. Skipping or finishing it counts as shown. The flag
/// lives in `UserDefaults`, so it survives relaunches and is cleared with the app's data.
@MainActor
@Observable
public final class GettingStartedModel {
    static let shownKey = "com.listora.getting-started-shown"

    /// True while the guide is on screen.
    public var isPresented = false
    private let defaults: UserDefaults
    /// Whether someone was signed in at the last report. The first report is the state at launch,
    /// which never shows the guide (`hasHeardState` tells it apart).
    @ObservationIgnored private var wasSignedIn = false
    @ObservationIgnored private var hasHeardState = false

    /// `showsNow` presents it at once whatever happened before (debug builds' screenshot tour).
    public init(defaults: UserDefaults, showsNow: Bool = false) {
        self.defaults = defaults
        isPresented = showsNow
    }

    private var hasBeenShown: Bool {
        defaults.bool(forKey: Self.shownKey)
    }

    /// Feed it every change of whether someone is signed in, starting with the current state.
    public func signedInChanged(_ isSignedIn: Bool) {
        defer {
            wasSignedIn = isSignedIn
            hasHeardState = true
        }
        guard hasHeardState, !wasSignedIn, isSignedIn, !hasBeenShown else { return }
        isPresented = true
    }

    /// The seller finished or skipped the guide: it does not come back.
    public func finish() {
        defaults.set(true, forKey: Self.shownKey)
        isPresented = false
    }

    /// Forgets that the guide was shown (`LISTORA_RESET_LOCAL_DATA`).
    static func resetLocalData(defaults: UserDefaults) {
        defaults.removeObject(forKey: shownKey)
    }
}
