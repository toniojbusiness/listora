import SwiftUI

/// The small mark on a feature that shows only because the owner's Test mode is on
/// (docs/features/test-mode.md): it has not passed a live end-to-end test yet. Quiet on purpose,
/// a neutral woven label without an icon, so testing never looks like a problem to fix.
public struct TestingTag: View {
    public init() {}

    public var body: some View {
        StatusBadge("Testing", tone: .neutral, showsIcon: false)
            .accessibilityLabel("Testing, not verified live yet")
            .accessibilityIdentifier("testing.tag")
    }
}

#Preview {
    TestingTag()
        .padding()
}
