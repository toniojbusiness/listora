import DesignSystem
import SwiftUI

/// This week's sales and profit next to last week's.
struct MoneySummaryView: View {
    let money: MoneySummaryContent

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader("This week", subtitle: "The last 7 days, next to the 7 before.")
            VStack(alignment: .leading, spacing: Spacing.sm) {
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                        Text(money.sales)
                            .font(Typography.priceLarge)
                            .foregroundStyle(Palette.textPrimary)
                        Spacer(minLength: Spacing.xs)
                        Text(money.itemsSold)
                            .font(Typography.subheadline)
                            .foregroundStyle(Palette.textSecondary)
                    }
                    Label(money.comparison.text, systemImage: money.comparison.systemImage)
                        .font(Typography.emphasis)
                        .foregroundStyle(money.comparison.tone.color)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("today.money.sales")
                Divider().overlay(Palette.separator.color)
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("Profit")
                            .font(Typography.body)
                            .foregroundStyle(Palette.textPrimary)
                        Spacer(minLength: Spacing.xs)
                        Text(money.profit ?? "Not known yet")
                            .font(money.profit == nil ? Typography.subheadline : Typography.price)
                            .foregroundStyle(money.profit == nil ? Palette.textSecondary : Palette.brand)
                    }
                    if let note = money.profitNote {
                        Text(note)
                            .font(Typography.footnote)
                            .foregroundStyle(Palette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("today.money.profit")
            }
            .cardStyle(.ruled)
        }
    }
}
