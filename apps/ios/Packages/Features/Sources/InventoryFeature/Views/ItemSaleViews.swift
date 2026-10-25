import DesignSystem
import ListoraAPI
import SwiftUI

/// A sale the item screen opens.
struct SaleLink: Identifiable, Hashable {
    let id: String
}

extension Item {
    /// Not sold or archived: a sale Listora did not see can be recorded.
    var canBeMarkedSold: Bool {
        switch status.value1 {
        case .draft, .ready, .listed: true
        case .soldPendingDelist, .sold, .shipped, .archived, nil: false
        }
    }
}

/// Where and for how much the item sold, its profit and ROI, and the delist everywhere else.
struct SoldSection: View {
    let summary: Components.Schemas.ItemSaleSummary
    let run: Components.Schemas.DelistRun?
    let open: () -> Void

    var body: some View {
        DetailSection(title: "Sold") {
            Button(action: open) {
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(soldOn)
                            .font(Typography.headline)
                            .foregroundStyle(Palette.textPrimary)
                        Spacer()
                        Text(Formatting.money(summary.salePrice))
                            .font(Typography.price)
                            .foregroundStyle(Palette.brand)
                    }
                    if let profit = summary.profit {
                        LabeledRow(
                            summary.feesEstimated == true ? "Profit (estimated)" : "Profit",
                            value: Formatting.money(profit),
                            note: summary.roiBasisPoints.map { "\(roi($0)) ROI" },
                        )
                    }
                    if let run {
                        StatusBadge(run.statusDisplay.label, tone: StatusTone(run.statusDisplay.tone))
                            .accessibilityIdentifier("item.delistRun")
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("item.sale")
        }
    }

    private var soldOn: String {
        let marketplace = summary.soldOn.map { Formatting.marketplaceName($0.id) } ?? "a marketplace"
        return "On \(marketplace), \(summary.soldAt.formatted(date: .abbreviated, time: .omitted))"
    }

    private func roi(_ basisPoints: Int64) -> String {
        let text = (Decimal(basisPoints) / 100).formatted(.number.precision(.fractionLength(0 ... 1)))
        return basisPoints > 0 ? "+\(text)%" : "\(text)%"
    }
}
