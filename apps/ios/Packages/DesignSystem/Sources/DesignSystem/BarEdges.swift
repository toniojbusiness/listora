import SwiftUI

extension View {
    /// A hard edge under the navigation bar instead of the soft fade, so content scrolling under
    /// the bar never shows through it (iOS 26; iOS 18 bars already have a material background).
    /// Apply it once at the root; the scroll views inside, pushed screens included, inherit it.
    @ViewBuilder
    public func solidBarEdges() -> some View {
        if #available(iOS 26, *) {
            scrollEdgeEffectStyle(.hard, for: .top)
        } else {
            self
        }
    }
}
