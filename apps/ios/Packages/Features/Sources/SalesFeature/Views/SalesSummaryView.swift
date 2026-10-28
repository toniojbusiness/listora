import DesignSystem
import ListoraAPI
import SwiftUI

/// All the seller's sales on a price tag: the total across every marketplace in Fraunces, then
/// each marketplace on the tag's string, a bead each with its own sales (the server's fixed
/// order, never ranked: eBay's licence forbids comparing marketplaces). A marketplace with no
/// sale yet hangs on a loose string.
struct SalesSummaryView: View {
    let summary: SalesSummary
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text("All your sales")
                    .font(Typography.eyebrow)
                    .foregroundStyle(Palette.textSecondary)
                Text(SaleFormatting.money(summary.total.revenue))
                    .font(Typography.priceLarge)
                    .foregroundStyle(Palette.textPrimary)
                Text(Self.counts(summary.total.salesCount, summary.total.itemsSold, since: summary.firstSoldAt))
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("sales.summary.total")
            if !summary.marketplaces.isEmpty {
                Divider().overlay(Palette.separator.color)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(summary.marketplaces.enumerated()), id: \.offset) { index, marketplace in
                        row(marketplace, at: index)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .tagStyle()
        // A container: each line keeps its own identifier.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sales.summary")
    }

    private func row(_ marketplace: Components.Schemas.MarketplaceSales, at index: Int) -> some View {
        let count = summary.marketplaces.count
        let next = index + 1 < count ? summary.marketplaces[index + 1] : nil
        return ThreadRow(
            position: .at(index, of: count),
            above: Self.string(to: marketplace),
            below: next.map(Self.string(to:)) ?? .taut,
        ) {
            ThreadBead(
                monogram: String(marketplace.marketplace.name.prefix(1)),
                tone: marketplace.salesCount > 0 ? .success : .neutral,
            )
        } content: {
            // The amount under the name at accessibility sizes, so neither breaks mid-word.
            let line = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.xxs))
                : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: Spacing.sm))
            line {
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(marketplace.marketplace.name)
                        .font(Typography.headline)
                        .foregroundStyle(Palette.textPrimary)
                    Text(marketplace.salesCount > 0
                        ? Self.counts(marketplace.salesCount, marketplace.itemsSold, since: nil)
                        : "No sales yet")
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                }
                if !dynamicTypeSize.isAccessibilitySize {
                    Spacer(minLength: Spacing.sm)
                }
                Text(SaleFormatting.money(marketplace.revenue))
                    .font(Typography.price)
                    .foregroundStyle(marketplace.salesCount > 0 ? Palette.textPrimary : Palette.textSecondary)
                    .fixedSize()
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("sales.summary.\(marketplace.marketplace.id)")
        }
    }

    /// Tied to a marketplace with sales, loose to one without any yet.
    private static func string(to marketplace: Components.Schemas.MarketplaceSales) -> ThreadStyle {
        marketplace.salesCount > 0 ? .taut : .loose
    }

    /// "41 sales, 44 items, since Sep 2026"; one item per sale says only the sales.
    static func counts(_ sales: Int32, _ items: Int32, since: Date?) -> String {
        var text = sales == 1 ? "1 sale" : "\(sales) sales"
        if items != sales {
            text += items == 1 ? ", 1 item" : ", \(items) items"
        }
        if let since {
            text += ", since \(since.formatted(.dateTime.month(.abbreviated).year()))"
        }
        return text
    }
}

#Preview {
    let money = { (cents: Int64) in Money(amountCents: cents, currency: .usd) }
    ScrollView {
        SalesSummaryView(summary: .init(
            total: .init(salesCount: 42, itemsSold: 45, revenue: money(93150)),
            marketplaces: [
                .init(marketplace: .init(value1: .depop), salesCount: 41, itemsSold: 44, revenue: money(92050)),
                .init(marketplace: .init(value1: .poshmark), salesCount: 0, itemsSold: 0, revenue: money(0)),
                .init(marketplace: .init(value1: .mercari), salesCount: 1, itemsSold: 1, revenue: money(1100)),
            ],
            firstSoldAt: Date(timeIntervalSince1970: 1_790_000_000),
        ))
        .padding()
    }
    .background(Palette.background)
}
