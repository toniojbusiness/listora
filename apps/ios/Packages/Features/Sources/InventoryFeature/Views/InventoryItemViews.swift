import DesignSystem
import ListoraAPI
import SwiftUI

/// One item: cover photo, title, SKU, status, price, and its status on each marketplace. The title
/// gets the row's full width; the price sits at the end of the SKU line. At accessibility sizes
/// the photo goes above the text and the price under the SKU, so nothing breaks mid-word.
struct InventoryRow: View {
    let item: ItemSummary
    /// Select mode, and whether the item is chosen.
    var isSelecting = false
    var isSelected = false
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
                .overlay(alignment: .topTrailing) {
                    if isSelecting {
                        SelectionMark(isSelected: isSelected).padding(Spacing.xxs)
                    }
                }
            HStack(alignment: .top, spacing: Spacing.xs) {
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(item.title ?? "Untitled item")
                        .font(Typography.headline)
                        .foregroundStyle(Palette.textPrimary)
                        .lineLimit(isAccessibilitySize ? nil : 2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    meta {
                        Text("\(item.sku) · \(item.status.label)")
                            .font(Typography.sku)
                            .foregroundStyle(Palette.textSecondary)
                            .frame(maxWidth: isAccessibilitySize ? nil : .infinity, alignment: .leading)
                        if let price = item.listPrice {
                            Text(Formatting.money(price))
                                .font(Typography.price)
                                .foregroundStyle(Palette.brand)
                                .fixedSize()
                        }
                    }
                    if item.needsYou {
                        NeedsYouBadge(item: item)
                    }
                    if !item.listings.isEmpty {
                        FlowLayout(spacing: Spacing.xs, lineSpacing: Spacing.xs) {
                            ForEach(item.listings, id: \.listingId) { listing in
                                MarketplaceBadge(listing: listing)
                            }
                        }
                        .padding(.top, Spacing.xxs)
                    } else if let note = item.noListingsNote {
                        Text(note)
                            .font(Typography.footnote)
                            .foregroundStyle(Palette.textSecondary)
                    }
                }
                if !isSelecting {
                    Image(systemName: "chevron.right")
                        .font(Typography.smallEmphasis)
                        .foregroundStyle(Palette.textSecondary)
                        .padding(.top, Spacing.xxs)
                        .accessibilityHidden(true)
                }
            }
        }
        // A long list is ruled, not boxed, so it stays calm at a hundred items.
        .cardStyle(.ruled, padding: Spacing.sm)
        .background {
            if isSelected {
                RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
                    .fill(Palette.brandSoft)
                    .padding(.horizontal, -Spacing.xs)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// One item in the grid: its cover photo, large and square, on a tag hanging from the row's rail,
/// with the item's status on it; then, on the page under the tag, the title, price, and SKU, and
/// each marketplace's status as a line in the server's words, in full.
struct InventoryGridCell: View {
    let item: ItemSummary
    /// Select mode, and whether the item is chosen.
    var isSelecting = false
    var isSelected = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HangingTag(railOverhang: Spacing.md / 2) { photo }
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
                        .font(Typography.price)
                        .foregroundStyle(Palette.brand)
                        .fixedSize()
                }
                Text(item.sku)
                    .font(Typography.sku)
                    .foregroundStyle(Palette.textSecondary)
                    .lineLimit(1)
            }
            if !item.listings.isEmpty {
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    ForEach(item.listings, id: \.listingId) { listing in
                        MarketplaceStatusLine(listing: listing)
                    }
                }
            } else if let note = item.noListingsNote {
                Text(note)
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var photo: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                // The thumbnail is sized to fill the widest cell sharply; the listing photo is
                // ten times its bytes.
                PhotoView(url: item.coverPhoto?.urls?.thumbnail, cornerRadius: Radius.small)
            }
            .overlay(alignment: .topLeading) {
                Chip(item.status.label)
                    .padding(Spacing.xs)
            }
            .overlay(alignment: .topTrailing) {
                if isSelecting {
                    SelectionMark(isSelected: isSelected).padding(Spacing.xs)
                }
            }
            .overlay(alignment: .bottomLeading) {
                if item.needsYou, !isSelecting {
                    NeedsYouBadge(item: item).padding(Spacing.xs)
                }
            }
            .overlay {
                if isSelected {
                    RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
                        .strokeBorder(Palette.brand.color, lineWidth: 3)
                }
            }
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

extension ItemSummary {
    /// A listing whose newest change failed or waits for the seller.
    var needsYou: Bool {
        listings.contains { listing in
            switch listing.statusDisplay.tone.value1 {
            case .failed, .actionNeeded: true
            default: false
            }
        }
    }

    /// What an item on no marketplace says instead of its listings.
    var noListingsNote: String? {
        switch status.value1 {
        case .ready: "Not listed anywhere yet"
        case .draft: "Review it, then list it"
        default: nil
        }
    }
}

/// "Needs you" on an item whose listing failed (red) or waits for the seller (amber).
private struct NeedsYouBadge: View {
    let item: ItemSummary

    var body: some View {
        let failed = item.listings.contains { $0.statusDisplay.tone.value1 == .failed }
        StatusBadge("Needs you", tone: failed ? .failed : .actionNeeded)
            .accessibilityIdentifier("inventory.needsYou.\(item.sku)")
    }
}

/// The check on a chosen item while selecting; an empty circle on one not chosen.
private struct SelectionMark: View {
    let isSelected: Bool

    var body: some View {
        Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
            .font(Typography.title3)
            .foregroundStyle(isSelected ? Palette.brand.color : Palette.onMedia.color)
            .background(Circle().fill(isSelected ? Palette.onBrand.color : Palette.scrim.color.opacity(0.35)))
            .accessibilityHidden(true)
    }
}
