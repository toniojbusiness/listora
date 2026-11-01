import Core
import DesignSystem
import SwiftUI

/// "What sells for you" as its screen shows it (docs/features/thrift-scan.md, "Sourcing
/// insights"): each brand and item type pair in words, from the household's own sales and stock.
/// A pair is always a brand with an item type, never a brand alone.
struct SourcingInsightsCard: Equatable {
    struct Row: Equatable, Identifiable {
        /// "Lululemon leggings".
        let title: String
        /// "5 of 6 sold · about 9 days to sell · ~$21 after fees".
        let detail: String
        /// "2 in stock now", so the seller doesn't buy more of what already waits.
        let stock: String?

        var id: String {
            title
        }

        init(_ group: SourcingKit.InsightGroup) {
            title = "\(group.brand) \(VocabularyName.itemType(group.category))"
            let judged = group.soldCount + group.unsoldCount
            var parts = ["\(group.soldCount) of \(judged) sold"]
            if let days = group.medianDaysToSell {
                parts.append(Self.days(days))
            }
            if let payout = group.medianPayout {
                parts.append("~\(Self.dollars(payout.amountCents)) after fees")
            }
            detail = parts.joined(separator: " · ")
            stock = group.inStockCount > 0 ? "\(group.inStockCount) in stock now" : nil
        }

        private static func days(_ days: Int) -> String {
            switch days {
            case 0: "sold within a day"
            case 1: "about 1 day to sell"
            default: "about \(days) days to sell"
            }
        }

        private static func dollars(_ cents: Int) -> String {
            (Decimal(cents) / 100).formatted(.currency(code: "USD").precision(.fractionLength(0)))
        }
    }

    let lookFor: [Row]
    let best: [Row]
    let worst: [Row]
    /// "From your 12 sales with a brand and item type, and what's in stock. Days to sell from
    /// the 4 Listora listed."
    let basedOn: String
    let isEmpty: Bool

    init(_ insights: SourcingKit.Insights) {
        lookFor = insights.lookFor.map(Row.init)
        best = insights.best.map(Row.init)
        worst = insights.worst.map(Row.init)
        isEmpty = insights.isEmpty
        let sales = insights.soldCount == 1 ? "1 sale" : "\(insights.soldCount) sales"
        var basedOn = "From your \(sales) with a brand and item type, and what's in stock."
        if insights.daysToSellCount > 0 {
            basedOn += " Days to sell from the \(insights.daysToSellCount) Listora listed."
        }
        self.basedOn = basedOn
    }
}

/// "What sells for you" (Hang Tag): the "Look for" list on a tag stamped "Look for", then what
/// sells best and slowest, ruled. Reads the sourcing kit on this iPhone, so it shows with no
/// signal; it fetches a newer kit when there is.
struct SourcingInsightsView: View {
    let kit: SourcingKitCache
    /// Fetches a newer kit when there is signal; the screen shows the one it has meanwhile.
    let refresh: @MainActor () async -> Void
    /// The first fetch is over: with no kit yet, there was no signal or Listora failed.
    @State private var refreshed = false

    var body: some View {
        content
            .background(Palette.background)
            .navigationTitle("What sells for you")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                await refresh()
                refreshed = true
            }
    }

    @ViewBuilder
    private var content: some View {
        if let kit = kit.kit {
            // A kit an earlier build kept has no insights: the newer one is on its way.
            let card = kit.insights.map(SourcingInsightsCard.init)
            if let card, !card.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: Spacing.lg) {
                        LookForTag(rows: card.lookFor)
                        rows("Sells best", subtitle: "Most of them sold, and not slowly.", card.best, id: "best")
                        rows("Sells slowest", subtitle: "Most still unsold, or slow to go.", card.worst, id: "worst")
                        Text(card.basedOn)
                            .font(Typography.footnote)
                            .foregroundStyle(Palette.textSecondary)
                            .accessibilityIdentifier("insights.basedOn")
                    }
                    .frame(maxWidth: Layout.readableWidth, alignment: .leading)
                    .frame(maxWidth: .infinity)
                    .padding(Spacing.md)
                }
            } else {
                EmptyStateView(
                    systemImage: "tag",
                    title: "Not enough sales yet",
                    message: "Once 3 or more of a brand's item type have sold, or sat unsold for a month, "
                        + "what sells for you shows here.",
                )
                .accessibilityIdentifier("insights.empty")
            }
        } else if refreshed {
            EmptyStateView(
                systemImage: "wifi.slash",
                title: "Couldn't load your sales",
                message: "Open this once with signal, and it stays on this iPhone for the store.",
            )
            .accessibilityIdentifier("insights.unavailable")
        } else {
            SkeletonList(count: 4, label: "Loading what sells for you") { SkeletonRow() }
        }
    }

    @ViewBuilder
    private func rows(_ title: String, subtitle: String, _ rows: [SourcingInsightsCard.Row], id: String) -> some View {
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                SectionHeader(title, subtitle: subtitle)
                ForEach(rows) { row in
                    InsightRow(row: row)
                        .cardStyle(.ruled, padding: Spacing.xs)
                        .accessibilityIdentifier("insights.\(id)")
                }
            }
        }
    }
}

/// The "Look for" list on a tag (Hang Tag): the brand and item type pairs that sell and pay
/// out enough, best first. Nothing when there are none.
struct LookForTag: View {
    let rows: [SourcingInsightsCard.Row]

    var body: some View {
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Stamp("Look for", tone: .success, angle: .degrees(-3))
                ForEach(rows) { row in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.title)
                            .font(Typography.price)
                            .foregroundStyle(Palette.textPrimary)
                        Text(row.detail)
                            .font(Typography.metadata)
                            .foregroundStyle(Palette.textSecondary)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("insights.lookFor")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .tagStyle()
            .accessibilityElement(children: .contain)
        }
    }
}

private struct InsightRow: View {
    let row: SourcingInsightsCard.Row

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(row.title)
                .font(Typography.headline)
                .foregroundStyle(Palette.textPrimary)
            Text(row.detail)
                .font(Typography.metadata)
                .foregroundStyle(Palette.textSecondary)
            if let stock = row.stock {
                Text(stock)
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// Scan mode's way to "What sells for you": its row names the top of the "Look for" list.
struct SourcingInsightsLink: View {
    let kit: SourcingKitCache

    var body: some View {
        NavigationLink(value: AddItemRoute.sourcingInsights) {
            ListRow("What sells for you", subtitle: Self.subtitle(kit.kit?.insights), systemImage: "tag")
        }
        .accessibilityIdentifier("addItem.sourcingInsights")
    }

    /// "Look for Lululemon leggings, Madewell jeans", or what the screen holds.
    static func subtitle(_ insights: SourcingKit.Insights?) -> String {
        let names = (insights?.lookFor ?? []).prefix(2).map(SourcingInsightsCard.Row.init).map(\.title)
        return names.isEmpty
            ? "Your best and slowest sellers, by brand and item type"
            : "Look for \(names.joined(separator: ", "))"
    }
}
