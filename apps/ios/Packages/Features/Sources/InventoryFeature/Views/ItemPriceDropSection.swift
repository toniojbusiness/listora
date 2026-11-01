import DesignSystem
import ListoraAPI
import SwiftUI

/// The item's price drop (docs/features/price-drops.md), under its marketplaces once it is live
/// where price drops show: the rule that applies (its own, or its brand's) and each listing's
/// next drop, before it runs. Without a rule, one tap makes the item its own.
struct ItemPriceDropSection: View {
    @State private var model: PriceDropsModel
    @State private var editing: PriceDropRuleEditorModel.Target?
    private let brand: String?
    /// Price drops show only because of the owner's Test mode (docs/features/test-mode.md).
    private let testing: Bool

    init(itemID: String, brand: String?, service: any PriceDropService, testing: Bool = false) {
        _model = State(initialValue: PriceDropsModel(itemID: itemID, service: service))
        self.brand = brand
        self.testing = testing
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            if let rule = model.rules.first {
                Button { editing = .existing(rule) } label: {
                    ListRow(
                        rule.scope.value1 == .brand ? "Price drop: \(PriceDropWords.target(rule))" : "Price drop",
                        subtitle: rule.enabled ? PriceDropWords.terms(rule) : "Off for this item",
                        systemImage: "tag",
                    ) {
                        accessory
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("item.priceDrop")
                if rule.enabled {
                    ForEach(model.planned, id: \.listingId) { drop in
                        PlannedDropRow(drop: drop)
                    }
                }
                if rule.scope.value1 == .brand, let itemID = model.itemID {
                    Button("Give this item its own rule") { editing = .newItem(itemID: itemID, brand: brand) }
                        .font(Typography.subheadline)
                        .accessibilityIdentifier("item.priceDrop.own")
                }
            } else if model.phase == .loaded, let itemID = model.itemID {
                Button { editing = .newItem(itemID: itemID, brand: brand) } label: {
                    ListRow(
                        "Price drop",
                        subtitle: "Lower its price if it doesn't sell, down to a price you choose",
                        systemImage: "tag",
                    ) {
                        accessory
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("item.priceDrop.add")
            }
            if let error = model.changeError {
                Text(error)
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .cardStyle(.ruled)
        .task { await model.load() }
        .sheet(item: $editing, onDismiss: { Task { await model.load() } }, content: { target in
            NavigationStack {
                PriceDropRuleEditor(model: PriceDropRuleEditorModel(target: target, service: model.service))
            }
        })
    }

    private var accessory: some View {
        HStack(spacing: Spacing.xs) {
            if testing {
                TestingTag()
            }
            Image(systemName: "chevron.right")
                .foregroundStyle(Palette.textSecondary)
                .accessibilityHidden(true)
        }
    }
}
