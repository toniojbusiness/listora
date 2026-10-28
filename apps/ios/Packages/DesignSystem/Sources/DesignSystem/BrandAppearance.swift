import UIKit

/// The UIKit chrome SwiftUI draws through appearance proxies: a navigation bar's large title
/// (Today, Inventory, Sales) is set in the display face, Fraunces, in `textPrimary`, scaled with
/// Dynamic Type like `Typography.largeTitle`. Inline titles stay the system's SF Pro.
@MainActor
public enum BrandAppearance {
    private static var isInstalled = false

    /// Installs the appearance once, before the first navigation bar is made, and again when the
    /// text size changes (bars made after the change pick it up).
    public static func install() {
        guard !isInstalled else { return }
        isInstalled = true
        apply()
        NotificationCenter.default.addObserver(
            forName: UIContentSizeCategory.didChangeNotification,
            object: nil,
            queue: .main,
        ) { _ in
            MainActor.assumeIsolated { apply() }
        }
    }

    static func apply() {
        _ = BrandFont.isRegistered
        guard let base = UIFont(name: BrandFont.postScriptName, size: 34) else { return }
        let font = UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: base)
        UINavigationBar.appearance().largeTitleTextAttributes = [
            .font: font,
            .foregroundColor: Palette.textPrimary.uiColor,
        ]
    }
}
