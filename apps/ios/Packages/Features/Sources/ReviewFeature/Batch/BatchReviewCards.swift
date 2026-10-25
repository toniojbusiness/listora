import Core
import DesignSystem
import SwiftUI

/// What the seller paid for a batch item, on the in-app keypad, with where it was bought, and a
/// way to apply it to every item still to approve: the same each, or the haul's total split.
struct BatchCostCard: View {
    @Bindable var model: ReviewFlowModel
    let batch: BatchReviewModel
    /// The page's number, 1 first.
    let number: Int
    /// The keypad is open. The first item's opens with the page while nothing is entered, and stays
    /// open as the seller types.
    @State private var isEditing: Bool

    init(model: ReviewFlowModel, batch: BatchReviewModel, number: Int) {
        self.model = model
        self.batch = batch
        self.number = number
        _isEditing = State(initialValue: number == 1 && model.cost.amount.isEmpty)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text("What you paid")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.textSecondary)
                    Text(model.cost.amount.isEmpty ? "Not entered" : model.cost.amount.display)
                        .font(Typography.priceLarge)
                        .foregroundStyle(model.cost.amount.isEmpty ? Palette.textSecondary : Palette.textPrimary)
                        .accessibilityIdentifier("batchReview.cost.\(number)")
                }
                Spacer()
                Button(isEditing ? "Done" : "Edit") {
                    isEditing.toggle()
                }
                .font(Typography.headline)
                .foregroundStyle(Palette.brand)
                .frame(minWidth: Layout.minimumTapTarget, minHeight: Layout.minimumTapTarget)
                .accessibilityIdentifier("batchReview.editCost.\(number)")
            }
            if isEditing {
                KeypadView { model.cost.amount.press($0) }
                sourceChoices
            } else if !model.cost.source.isEmpty {
                Text("From \(model.cost.source)")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.textSecondary)
            }
            if batch.hasAppliedCost(model) {
                Label("Applied to every item still to approve", systemImage: "checkmark.circle.fill")
                    .font(Typography.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.success)
                    .accessibilityIdentifier("batchReview.costApplied.\(number)")
            } else if !model.cost.amount.isEmpty, batch.remaining.count > 1 {
                applyToAll
            }
        }
        .cardStyle()
    }

    private var sourceChoices: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            TextField("Where you bought it", text: $model.cost.source)
                .font(Typography.body)
                .foregroundStyle(Palette.textPrimary)
                .submitLabel(.done)
                .frame(minHeight: Layout.minimumTapTarget)
                .accessibilityIdentifier("batchReview.source.\(number)")
            let recent = batch.recentSources.sources
            if !recent.isEmpty {
                FlowLayout {
                    ForEach(recent, id: \.self) { source in
                        ChoiceChip(source, isSelected: model.cost.source == source) {
                            model.cost.source = source
                        }
                    }
                }
            }
        }
    }

    /// The haul's cost for every item still to approve, in one tap: split across them, or the same
    /// for each.
    private var applyToAll: some View {
        let count = batch.remaining.count
        let cents = model.cost.amount.cents ?? 0
        let share = BatchReviewModel.amounts(.total(cents), count: count).last ?? 0
        let total = Formatting.money(cents: cents)
        let each = Formatting.money(cents: share)
        return VStack(alignment: .leading, spacing: Spacing.xs) {
            Label("Apply to all \(count) items", systemImage: "square.stack.3d.up.fill")
                .font(Typography.subheadline.weight(.semibold))
                .foregroundStyle(Palette.textPrimary)
            AdaptiveStack {
                Button("Split \(total): \(each) each") {
                    Haptics.play(.selection)
                    batch.applyCost(from: model, as: .total(cents))
                }
                .buttonStyle(.listora(.secondary, size: .compact))
                .accessibilityLabel("Split \(total) across \(count) items, \(each) each")
                .accessibilityIdentifier("batchReview.splitCost.\(number)")
                Button("\(total) each") {
                    Haptics.play(.selection)
                    batch.applyCost(from: model, as: .each(cents))
                }
                .buttonStyle(.listora(.tertiary, size: .compact))
                .accessibilityLabel("\(total) for each of the \(count) items")
                .accessibilityIdentifier("batchReview.sameCost.\(number)")
            }
        }
    }
}

/// The price a batch item is saved at: the server's tiers, the recommended one preselected, with
/// the server's own label and any floor it would go under.
struct BatchPriceCard: View {
    let model: ReviewFlowModel

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Price")
                .font(Typography.caption)
                .foregroundStyle(Palette.textSecondary)
            switch model.pricing {
            case .idle, .loading:
                ProgressView().frame(maxWidth: .infinity, alignment: .leading)
            case let .failed(message):
                Banner("Couldn't load prices", message: message, tone: .failed, action: .init("Try again") {
                    Task { await model.loadPricing() }
                })
            case let .loaded(presentation):
                if presentation.tiers.isEmpty {
                    Text("No estimate for this item. Set the price in the item's full review.")
                        .font(Typography.callout)
                        .foregroundStyle(Palette.textSecondary)
                }
                FlowLayout {
                    ForEach(presentation.tiers) { tier in
                        ChoiceChip(
                            "\(Self.tierName(tier)) \(tier.price)",
                            isSelected: model.priceChoice == .tier(tier.tier),
                        ) {
                            model.priceChoice = .tier(tier.tier)
                        }
                        .accessibilityIdentifier("batchReview.tier.\(tier.tier.rawValue)")
                    }
                }
                if let tier = presentation.tiers.first(where: { model.priceChoice == .tier($0.tier) }) {
                    // The server's own label, as sent ("Recommended (AI estimate)").
                    Text(tier.label)
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                }
                if let cents = model.chosenCents, let warning = presentation.warning(for: cents) {
                    Label(warning, systemImage: "exclamationmark.triangle.fill")
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.warning)
                }
            }
        }
        .cardStyle()
    }

    private static func tierName(_ tier: PricingPresentation.Tier) -> String {
        switch tier.tier {
        case .quickSale: "Quick sale"
        case .recommended: "Recommended"
        case .higherProfit: "Higher profit"
        }
    }
}
