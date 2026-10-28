import DesignSystem
import SwiftUI

/// The cost screen's "Part of a haul": pick the haul of the trip the seller is on, or enter a new
/// one's total and how many items it had on the keypad. Either way it shows what each item costs
/// ("$1.67 each, from a $50 haul of 30"); the server keeps each item's share.
struct HaulCostSection: View {
    @Bindable var model: ReviewFlowModel
    /// The chosen haul's count is open on the keypad to be fixed.
    @State private var isFixingCount = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            choices
            if let haul = model.cost.haul {
                saved(haul)
            } else {
                newHaul
            }
        }
    }

    /// The latest hauls, and a new one.
    @ViewBuilder
    private var choices: some View {
        let hauls = model.recentHauls
        if !hauls.isEmpty || model.cost.haul != nil {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text("Your hauls")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                FlowLayout {
                    ForEach(hauls, id: \.id) { haul in
                        ChoiceChip(HaulPresentation.choice(haul), isSelected: model.cost.haul?.id == haul.id) {
                            model.cost.haul = haul
                            isFixingCount = false
                        }
                        .accessibilityIdentifier("cost.haul")
                    }
                    ChoiceChip("New haul", systemImage: "plus", isSelected: model.cost.haul == nil) {
                        model.cost.haul = nil
                        isFixingCount = false
                    }
                    .accessibilityIdentifier("cost.newHaul")
                }
            }
        }
    }

    /// A saved haul: what each item costs, and its count to fix.
    private func saved(_ haul: Haul) -> some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            summary
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text("Items in the haul")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.textSecondary)
                    Text(isFixingCount ? model.cost.haulCount.display : "\(haul.itemCount)")
                        .font(Typography.price)
                        .foregroundStyle(Palette.textPrimary)
                        .accessibilityIdentifier("cost.haulCount")
                    Text("\(haul.itemsAdded) added to Listora so far")
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                }
                Spacer()
                Button(isFixingCount ? "Save" : "Fix count") {
                    if isFixingCount {
                        Task {
                            await model.fixHaulCount()
                            isFixingCount = false
                        }
                    } else {
                        model.cost.haulCount = CountEntry(Int(haul.itemCount))
                        isFixingCount = true
                    }
                }
                .font(Typography.headline)
                .foregroundStyle(Palette.brand)
                .disabled(isFixingCount && model.cost.haulCount.value == nil)
                .frame(minWidth: Layout.minimumTapTarget, minHeight: Layout.minimumTapTarget)
                .accessibilityIdentifier("cost.fixHaulCount")
            }
            if isFixingCount {
                KeypadView { model.cost.haulCount.press($0) }
            }
        }
        .cardStyle()
    }

    /// A new haul: its total and its count, one keypad for both.
    private var newHaul: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            HStack(spacing: Spacing.sm) {
                field(
                    "Total paid",
                    value: model.cost.haulTotal.display,
                    isEmpty: model.cost.haulTotal.isEmpty,
                    field: .total,
                    identifier: "cost.haulTotal",
                )
                field(
                    "Items in it",
                    value: model.cost.haulCount.display,
                    isEmpty: model.cost.haulCount.isEmpty,
                    field: .count,
                    identifier: "cost.haulCount",
                )
            }
            summary
            KeypadView { key in
                switch model.cost.haulField {
                case .total: model.cost.haulTotal.press(key)
                case .count: model.cost.haulCount.press(key)
                }
            }
        }
    }

    @ViewBuilder
    private var summary: some View {
        if let summary = model.haulSummary {
            Text(summary)
                .font(Typography.headline)
                .foregroundStyle(Palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("cost.haulSummary")
        } else {
            Text("Enter what the whole haul cost and how many items it had.")
                .font(Typography.callout)
                .foregroundStyle(Palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// One of the new haul's two numbers; tapping it points the keypad at it.
    private func field(
        _ title: String,
        value: String,
        isEmpty: Bool,
        field: CostDraft.HaulField,
        identifier: String,
    ) -> some View {
        let isSelected = model.cost.haulField == field
        return Button {
            model.cost.haulField = field
        } label: {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(title)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                Text(value)
                    .font(Typography.amountEntry)
                    .foregroundStyle(isEmpty ? Palette.textSecondary : Palette.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
            }
            .frame(maxWidth: .infinity, minHeight: Layout.buttonHeight, alignment: .leading)
            .padding(Spacing.sm)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
                    .strokeBorder(
                        isSelected ? Palette.brand.color : Palette.separator.color,
                        lineWidth: isSelected ? 2 : 1,
                    ),
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityValue(isEmpty ? "None" : value)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }
}

extension CountEntry {
    /// The digits typed, thousands grouped; "0" while empty.
    var display: String {
        value.map { $0.formatted() } ?? "0"
    }
}
