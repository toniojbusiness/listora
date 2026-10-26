import DesignSystem
import ListoraAPI
import SwiftUI

/// "Relist it?" after a cancel or return: the item's listings, each relistable one a choice.
struct RelistSection: View {
    let sale: Sale
    let model: SaleDetailModel

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader(
                "Relist it?",
                subtitle: sale.pendingRelists.isEmpty
                    ? nil
                    : "The sale was \(sale.status.label.lowercased()). Listora relists only where you choose.",
            )
            VStack(alignment: .leading, spacing: Spacing.md) {
                ForEach(sale.items.filter { $0.relist != nil }, id: \.itemId) { item in
                    if let relist = item.relist {
                        itemRows(item, relist: relist)
                    }
                }
                if !sale.pendingRelists.isEmpty {
                    let chosen = model.relistChoices.values.reduce(0) { $0 + $1.count }
                    VStack(spacing: Spacing.xs) {
                        Button(relistTitle(chosen)) {
                            Task { await model.answerRelist() }
                        }
                        .buttonStyle(.listoraPrimary)
                        .disabled(chosen == 0 || model.isSending)
                        .accessibilityIdentifier("relist.confirm")
                        Button("Don't relist") { Task { await model.declineRelist() } }
                            .buttonStyle(.listora(.tertiary, size: .compact))
                            .disabled(model.isSending)
                            .accessibilityIdentifier("relist.decline")
                    }
                }
            }
            .cardStyle()
        }
    }

    private func itemRows(_ item: SaleItem, relist: Components.Schemas.SaleRelist) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            if sale.items.count > 1 {
                Text(item.title ?? item.sku)
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
            }
            switch relist.decision.value1 {
            case .pending:
                ForEach(relist.options, id: \.listingId) { option in
                    optionRow(option, itemID: item.itemId)
                }
                if relist.options.isEmpty {
                    Text("It isn't listed anywhere. List it again from the item.")
                        .font(Typography.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                }
            case .relisted:
                Text("Relisting. Each marketplace's status is on the item.")
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textPrimary)
                    .accessibilityIdentifier("relist.done")
            case .declined:
                Text("You chose not to relist it.")
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityIdentifier("relist.done")
            case nil:
                EmptyView()
            }
        }
    }

    private func optionRow(_ option: Components.Schemas.RelistOption, itemID: String) -> some View {
        let name = option.marketplace.name
        let chosen = model.relistChoices[itemID]?.contains(option.listingId) ?? false
        return HStack(alignment: .center, spacing: Spacing.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .font(Typography.emphasis)
                    .foregroundStyle(Palette.textPrimary)
                StatusBadge(option.statusDisplay.label, tone: StatusTone(option.statusDisplay.tone))
            }
            Spacer(minLength: Spacing.sm)
            if option.canRelist {
                ChoiceChip("Relist", isSelected: chosen) { model.toggle(listingID: option.listingId, of: itemID) }
                    .accessibilityIdentifier("relist.option.\(option.marketplace.id)")
            } else if option.mode.value1 == .assisted {
                Text("Relist in the \(name) app")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
            }
        }
    }
}

/// The delist on every other marketplace, as the server reports each one.
struct DelistSection: View {
    let sale: Sale

    var body: some View {
        ForEach(sale.delistRuns, id: \.id) { run in
            VStack(alignment: .leading, spacing: Spacing.xs) {
                SectionHeader("Other marketplaces", subtitle: run.statusDisplay.label)
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    if run.results.isEmpty {
                        Text("It wasn't listed anywhere else.")
                            .font(Typography.subheadline)
                            .foregroundStyle(Palette.textSecondary)
                    }
                    ForEach(run.results, id: \.listingId) { result in
                        HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                            Text(result.marketplace.name)
                                .font(Typography.emphasis)
                                .foregroundStyle(Palette.textPrimary)
                            Spacer(minLength: Spacing.sm)
                            StatusBadge(result.statusDisplay.label, tone: StatusTone(result.statusDisplay.tone))
                                .accessibilityIdentifier("sale.delist.\(result.marketplace.id)")
                        }
                    }
                }
                .cardStyle()
            }
        }
    }
}

/// The sale's money: price, shipping, each fee, payout, label cost, cost, profit, and ROI.
struct MoneySection: View {
    let sale: Sale

    var body: some View {
        let estimated = sale.feesEstimated == true
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader(
                "Fees and profit",
                subtitle: estimated
                    ? "Fees are estimated from \(sale.marketplace.name)'s published fees until it reports them."
                    : nil,
            )
            VStack(alignment: .leading, spacing: Spacing.sm) {
                MoneyRow("Sale price", sale.salePrice)
                if let shipping = sale.shippingCharged, shipping.amountCents != 0 {
                    MoneyRow("Shipping paid by buyer", shipping)
                }
                ForEach(Array((sale.fees ?? []).enumerated()), id: \.offset) { _, fee in
                    MoneyRow(
                        fee.description ?? fee._type.label,
                        fee.amount,
                        negative: true,
                        note: fee.source == .estimated ? "Estimated" : "From \(sale.marketplace.name)",
                    )
                }
                if let payout = sale.netProceeds {
                    Divider()
                    MoneyRow(estimated ? "Payout (estimated)" : "Payout", payout)
                        .accessibilityIdentifier("sale.payout")
                }
                if let label = sale.shippingCost {
                    MoneyRow("Shipping label", label, negative: true)
                }
                if let cost = sale.cost {
                    MoneyRow("Cost", cost, negative: true)
                }
                profitRow
            }
            .cardStyle()
        }
    }

    @ViewBuilder
    private var profitRow: some View {
        if sale.status.isUndone {
            Text("No profit: the sale was \(sale.status.label.lowercased()).")
                .font(Typography.subheadline)
                .foregroundStyle(Palette.textSecondary)
        } else if let profit = sale.profit {
            Divider()
            HStack(alignment: .firstTextBaseline) {
                Text(sale.feesEstimated == true ? "Profit (estimated)" : "Profit")
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(SaleFormatting.money(profit))
                        .font(Typography.price)
                        .foregroundStyle(profit.amountCents < 0 ? Palette.danger : Palette.success)
                    if let roi = sale.roiBasisPoints {
                        Text("\(SaleFormatting.roi(basisPoints: roi)) ROI")
                            .font(Typography.smallEmphasis)
                            .foregroundStyle(Palette.textSecondary)
                    }
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("sale.profit")
        } else {
            Text("Add the item's cost to see the profit.")
                .font(Typography.subheadline)
                .foregroundStyle(Palette.textSecondary)
        }
    }
}

/// Each item's share of a bundle.
struct ItemsSection: View {
    let sale: Sale

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader("Items", subtitle: "Shipping and order fees are split by each item's price.")
            VStack(alignment: .leading, spacing: Spacing.sm) {
                ForEach(sale.items, id: \.itemId) { item in
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title ?? "Untitled item")
                                .font(Typography.emphasis)
                                .foregroundStyle(Palette.textPrimary)
                            Text(item.sku)
                                .font(Typography.metadata)
                                .foregroundStyle(Palette.textSecondary)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(SaleFormatting.money(item.salePrice))
                                .font(Typography.emphasis)
                                .foregroundStyle(Palette.textPrimary)
                            if let profit = item.profit {
                                Text("Profit \(SaleFormatting.money(profit))")
                                    .font(Typography.metadata)
                                    .foregroundStyle(Palette.textSecondary)
                            }
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .cardStyle()
        }
    }
}

/// "Fee  -$6.12", with an optional note under the amount.
struct MoneyRow: View {
    let label: String
    let money: Money
    let negative: Bool
    let note: String?

    init(_ label: String, _ money: Money, negative: Bool = false, note: String? = nil) {
        self.label = label
        self.money = money
        self.negative = negative
        self.note = note
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
            Text(label)
                .font(Typography.subheadline)
                .foregroundStyle(Palette.textSecondary)
            Spacer(minLength: Spacing.sm)
            VStack(alignment: .trailing, spacing: 2) {
                Text(negative && money.amountCents != 0
                    ? "-\(SaleFormatting.money(money))"
                    : SaleFormatting.money(money))
                    .font(Typography.emphasis)
                    .foregroundStyle(Palette.textPrimary)
                if let note {
                    Text(note)
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// "Mark shipped", with what the label cost when the seller bought it outside the marketplace.
struct ShipSaleView: View {
    let ship: (Int64?) -> Void
    @State private var labelCents: Int?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                PriceField(
                    "Label cost (optional)",
                    minorUnits: $labelCents,
                    hint: "Only a label you paid for outside the marketplace. "
                        + "One the marketplace deducted is already a fee.",
                )
                .padding(Spacing.md)
            }
            .background(Palette.background)
            .bottomActionBar {
                Button("Mark shipped", systemImage: "shippingbox") { ship(labelCents.map(Int64.init)) }
                    .buttonStyle(.listoraPrimary)
                    .accessibilityIdentifier("ship.save")
            }
            .navigationTitle("Mark shipped")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// The relist button's title for the number of listings chosen.
private func relistTitle(_ chosen: Int) -> String {
    switch chosen {
    case 0: "Choose where to relist"
    case 1: "Relist on 1 marketplace"
    default: "Relist on \(chosen) marketplaces"
    }
}
