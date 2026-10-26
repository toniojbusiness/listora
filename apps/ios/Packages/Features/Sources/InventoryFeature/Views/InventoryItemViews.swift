import DesignSystem
import ListoraAPI
import SwiftUI

/// One item: cover photo, title, SKU, status, price, and its status on each marketplace. The title
/// gets the row's full width; the price sits at the end of the SKU line. At accessibility sizes
/// the photo goes above the text and the price under the SKU, so nothing breaks mid-word.
struct InventoryRow: View {
    let item: ItemSummary
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let isAccessibilitySize = dynamicTypeSize.isAccessibilitySize
        let outer = isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.sm))
            : AnyLayout(HStackLayout(alignment: .top, spacing: Spacing.sm))
        let meta = isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.xxs))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: Spacing.xs))
        outer {
            PhotoView(url: item.coverPhoto?.urls?.thumbnail, cornerRadius: Radius.medium)
                .frame(width: 72, height: 72)
            HStack(alignment: .top, spacing: Spacing.xs) {
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(item.title ?? "Untitled item")
                        .font(Typography.headline)
                        .foregroundStyle(Palette.textPrimary)
                        .lineLimit(isAccessibilitySize ? nil : 2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    meta {
                        Text("\(item.sku) · \(item.status.label)")
                            .font(Typography.metadata)
                            .foregroundStyle(Palette.textSecondary)
                            .frame(maxWidth: isAccessibilitySize ? nil : .infinity, alignment: .leading)
                        if let price = item.listPrice {
                            Text(Formatting.money(price))
                                .font(Typography.number)
                                .foregroundStyle(Palette.textPrimary)
                                .fixedSize()
                        }
                    }
                    if !item.listings.isEmpty {
                        FlowLayout(spacing: Spacing.xs, lineSpacing: Spacing.xs) {
                            ForEach(item.listings, id: \.listingId) { listing in
                                MarketplaceBadge(listing: listing)
                            }
                        }
                        .padding(.top, Spacing.xxs)
                    }
                }
                Image(systemName: "chevron.right")
                    .font(Typography.smallEmphasis)
                    .foregroundStyle(Palette.textSecondary)
                    .padding(.top, Spacing.xxs)
                    .accessibilityHidden(true)
            }
        }
        .cardStyle(.flat, padding: Spacing.sm)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// One item in the grid: its cover photo, large and square, with the item's status on it; the
/// title, price, and SKU; and each marketplace's status as a line in the server's words, in full.
/// No card around it: the photo carries the cell.
struct InventoryGridCell: View {
    let item: ItemSummary

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Color.clear
                .aspectRatio(1, contentMode: .fit)
                .overlay {
                    // The listing size: the thumbnail is too small to fill a cell sharply.
                    PhotoView(
                        url: item.coverPhoto?.urls?.listing ?? item.coverPhoto?.urls?.thumbnail,
                        cornerRadius: Radius.large,
                    )
                }
                .overlay(alignment: .topLeading) {
                    Chip(item.status.label)
                        .padding(Spacing.xs)
                }
                .padding(.bottom, Spacing.xxs)
            Text(item.title ?? "Untitled item")
                .font(Typography.headline)
                .foregroundStyle(Palette.textPrimary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                if let price = item.listPrice {
                    Text(Formatting.money(price))
                        .font(Typography.number)
                        .foregroundStyle(Palette.textPrimary)
                        .fixedSize()
                }
                Text(item.sku)
                    .font(Typography.metadata)
                    .foregroundStyle(Palette.textSecondary)
                    .lineLimit(1)
            }
            if !item.listings.isEmpty {
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    ForEach(item.listings, id: \.listingId) { listing in
                        MarketplaceStatusLine(listing: listing)
                    }
                }
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// "eBay: Active (confirmed by eBay)" as one line of text in the status's tone, with its icon:
/// the grid's lighter form of ``MarketplaceBadge``. The label is the server's, in full.
struct MarketplaceStatusLine: View {
    let listing: Components.Schemas.ListingStatusSummary

    var body: some View {
        let tone = StatusTone(listing.statusDisplay.tone)
        Label {
            let name = Text("\(Formatting.marketplaceName(listing.marketplace.id)):")
                .foregroundStyle(Palette.textSecondary)
            let status = Text(listing.statusDisplay.label).foregroundStyle(tone.color)
            Text("\(name) \(status)")
        } icon: {
            Image(systemName: tone.systemImage)
                .foregroundStyle(tone.color)
                .imageScale(.small)
        }
        .font(Typography.footnote)
        .labelStyle(StatusLineLabelStyle())
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// An icon and text with a tight gap, the icon on the first line of wrapped text.
private struct StatusLineLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.xxs) {
            configuration.icon
            configuration.title
        }
    }
}

/// "eBay" and the listing's status pill, exactly as the server words it.
struct MarketplaceBadge: View {
    let listing: Components.Schemas.ListingStatusSummary

    var body: some View {
        HStack(spacing: Spacing.xxs) {
            Text(Formatting.marketplaceName(listing.marketplace.id))
                .font(Typography.label)
                .foregroundStyle(Palette.textPrimary)
                .fixedSize()
            StatusBadge(listing.statusDisplay.label, tone: StatusTone(listing.statusDisplay.tone))
        }
        .accessibilityElement(children: .combine)
    }
}
