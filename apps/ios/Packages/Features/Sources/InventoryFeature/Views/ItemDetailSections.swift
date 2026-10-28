import DesignSystem
import ListoraAPI
import SwiftUI

/// Everything that happened to the item, from every marketplace action to every sale check.
struct ActivityLink: View {
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            ListRow(
                "Activity",
                subtitle: "Every step Listora took with this item, and when",
                systemImage: "clock.arrow.circlepath",
            ) {
                Image(systemName: "chevron.right")
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityHidden(true)
            }
            .cardStyle()
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("item.activity")
    }
}

/// Title, SKU, status, and list price.
struct ItemHeader: View {
    let item: Item
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        // The price under the title at accessibility sizes, so neither breaks mid-word.
        let heading = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.xxs))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: Spacing.sm))
        VStack(alignment: .leading, spacing: Spacing.xs) {
            heading {
                Text(item.details.title ?? "Untitled item")
                    .font(Typography.title)
                    .foregroundStyle(Palette.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("item.title")
                if let price = item.details.listPrice {
                    Text(Formatting.money(price))
                        .font(Typography.price)
                        .foregroundStyle(Palette.textPrimary)
                        .fixedSize()
                        .accessibilityLabel("List price \(Formatting.money(price))")
                }
            }
            // The chip wraps under the SKU rather than breaking it.
            FlowLayout(spacing: Spacing.xs, lineSpacing: Spacing.xs) {
                Text(item.sku)
                    .font(Typography.metadata)
                    .foregroundStyle(Palette.textSecondary)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("item.sku")
                Chip(item.status.label)
                    .accessibilityIdentifier("item.status")
            }
        }
    }
}

/// List price, cost, and profit: the sale's profit once sold, before that an estimate before
/// marketplace fees, labeled as such.
struct MoneySection: View {
    let item: Item

    var body: some View {
        DetailSection(title: "Cost and profit") {
            LabeledRow("List price", value: item.details.listPrice.map(Formatting.money) ?? "Not set")
            LabeledRow(
                "Cost",
                value: item.details.cost.map(Formatting.money) ?? "Not set",
                note: item.haul.map { "Its share of a \(Formatting.money($0.total)) haul of \($0.itemCount)" },
            )
            .accessibilityIdentifier("item.cost")
            if let profit = item.saleSummary?.profit {
                LabeledRow(
                    "Profit",
                    value: Formatting.money(profit),
                    note: item.saleSummary?.feesEstimated == true ? "With estimated fees" : nil,
                )
                .accessibilityIdentifier("item.profit")
            } else if let price = item.details.listPrice, let cost = item.details.cost {
                LabeledRow(
                    "Profit at list price",
                    value: Formatting.money(cents: price.amountCents - cost.amountCents),
                    note: "Before marketplace fees and shipping",
                )
                .accessibilityIdentifier("item.profit")
            }
            if let source = item.details.purchaseSource {
                LabeledRow("Bought at", value: source)
            }
        }
    }
}

extension Components.Schemas.ItemCondition {
    var label: String {
        switch self {
        case .newWithTags: "New with tags"
        case .newWithoutTags: "New without tags"
        case .newWithDefects: "New with defects"
        case .preOwnedExcellent: "Pre-owned, excellent"
        case .preOwnedGood: "Pre-owned, good"
        case .preOwnedFair: "Pre-owned, fair"
        }
    }
}
