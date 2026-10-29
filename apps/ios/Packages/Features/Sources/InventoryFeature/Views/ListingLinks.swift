import DesignSystem
import SwiftUI

/// "View on eBay" and Share, for a listing with its marketplace link.
struct ListingLinks: View {
    let url: URL
    let row: MarketplaceRowState

    var body: some View {
        HStack(spacing: Spacing.xs) {
            Link(destination: url) {
                Label("View on \(row.name)", systemImage: "arrow.up.right.square")
            }
            .buttonStyle(.listora(.tertiary, size: .compact))
            .accessibilityIdentifier("marketplace.\(row.id).view")
            ShareLink(item: url) {
                Label("Share", systemImage: "square.and.arrow.up")
            }
            .buttonStyle(.listora(.tertiary, size: .compact))
            .accessibilityIdentifier("marketplace.\(row.id).share")
        }
    }
}
