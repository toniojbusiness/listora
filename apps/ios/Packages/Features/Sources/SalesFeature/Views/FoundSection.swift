import DesignSystem
import ListoraAPI
import SwiftUI

/// How Listora found the sale and what it then did on each other marketplace
/// (docs/features/activity.md): when it sold and each delist's result, in the server's words.
/// Which check saw it, where it ran, and its timings are Listora's diagnostics, not the seller's.
struct FoundSection: View {
    let explanation: SaleExplanation

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader("How Listora found it", subtitle: explanation.detection)
            VStack(alignment: .leading, spacing: Spacing.sm) {
                ForEach(FoundSectionContent(explanation).facts, id: \.self) { fact in
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                        Text(fact.label)
                            .font(Typography.subheadline)
                            .foregroundStyle(Palette.textSecondary)
                        Spacer(minLength: Spacing.sm)
                        Text(fact.value)
                            .font(Typography.subheadline)
                            .foregroundStyle(Palette.textPrimary)
                            .multilineTextAlignment(.trailing)
                    }
                    .accessibilityElement(children: .combine)
                }
                ForEach(Array(explanation.delists.enumerated()), id: \.offset) { _, delist in
                    Divider()
                    VStack(alignment: .leading, spacing: Spacing.xxs) {
                        Text(delist.marketplace.name)
                            .font(Typography.emphasis)
                            .foregroundStyle(Palette.textPrimary)
                        Text(delist.result)
                            .font(Typography.subheadline)
                            .foregroundStyle(Palette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("sale.found.delist.\(delist.marketplace.value1?.rawValue ?? "other")")
                }
            }
            .cardStyle()
        }
        .accessibilityIdentifier("sale.found")
    }
}

/// The facts of ``FoundSection``, worded for the screen.
struct FoundSectionContent {
    struct Fact: Hashable {
        let label: String
        let value: String
    }

    let facts: [Fact]

    init(_ explanation: SaleExplanation) {
        facts = [Fact(label: "Sold", value: Self.time(explanation.soldAt))]
    }

    private static func time(_ date: Date) -> String {
        date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
}
