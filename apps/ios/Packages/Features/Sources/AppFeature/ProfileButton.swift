import DesignSystem
import SwiftUI
import UIKit

/// The seller's avatar in the Today and Sales headers, which opens their profile and settings.
/// While a marketplace connection needs attention it carries a dot.
struct ProfileButton: View {
    let initials: String
    let photo: UIImage?
    let needsAttention: Bool
    let action: @MainActor () -> Void

    var body: some View {
        Button(action: action) {
            Avatar(initials: initials, image: photo, size: .toolbar)
                .overlay(alignment: .topTrailing) {
                    if needsAttention {
                        Circle()
                            .fill(Palette.warning.color)
                            .frame(width: 10, height: 10)
                            .overlay(Circle().strokeBorder(Palette.background.color, lineWidth: 2))
                            .offset(x: 2, y: -2)
                    }
                }
                .frame(minWidth: Layout.minimumTapTarget, minHeight: Layout.minimumTapTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Profile and settings")
        .accessibilityValue(needsAttention ? "A marketplace connection needs attention" : "")
        .accessibilityIdentifier("settings.open")
    }
}
