import Core
import DesignSystem
import SwiftUI

/// The saved inventory item: its SKU, title, and price, and how long it took.
struct SavedItemView: View {
    let saved: ReviewFlowModel.SavedItem
    let onDone: () -> Void
    /// List it now: the item, with List everywhere open.
    let onListNow: () -> Void

    var body: some View {
        CenteredScroll { content }
            .background(Palette.background)
            .navigationTitle("Saved")
            .navigationBarTitleDisplayMode(.inline)
            .tabRailHidden()
            .bottomActionBar {
                Button("List it now", systemImage: "tag.fill", action: onListNow)
                    .buttonStyle(.listoraPrimary)
                    .accessibilityIdentifier("saved.listNow")
                Button("Done", action: onDone)
                    .buttonStyle(.listoraSecondary)
                    .accessibilityIdentifier("saved.done")
            }
            .sensoryFeedback(.success, trigger: saved.sku)
    }

    private var content: some View {
        VStack(spacing: Spacing.lg) {
            IconTile(systemImage: "checkmark", tone: .success, size: .hero)
            VStack(spacing: Spacing.xs) {
                Text("Saved to inventory")
                    .font(Typography.title)
                    .foregroundStyle(Palette.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                if let title = saved.title {
                    Text(title)
                        .font(Typography.body)
                        .foregroundStyle(Palette.textSecondary)
                        .lineLimit(3)
                }
            }
            .multilineTextAlignment(.center)
            itemCard
            if let summary = saved.summary {
                metric(summary)
            }
        }
    }

    /// The SKU to write on the item's tag, and the price it was saved at.
    private var itemCard: some View {
        VStack(spacing: Spacing.sm) {
            VStack(spacing: Spacing.xxs) {
                Text("SKU")
                    .font(Typography.eyebrow)
                    .tracking(0.6)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityHidden(true)
                Text(saved.sku)
                    .font(Typography.priceLarge)
                    .foregroundStyle(Palette.textPrimary)
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                    .textSelection(.enabled)
                    .accessibilityLabel("SKU \(saved.sku)")
                    .accessibilityIdentifier("saved.sku")
            }
            .frame(maxWidth: .infinity)
            if let price = saved.price {
                Divider().overlay(Palette.separator.color)
                HStack(alignment: .firstTextBaseline) {
                    Text("Price")
                        .font(Typography.body)
                        .foregroundStyle(Palette.textSecondary)
                        .accessibilityHidden(true)
                    Spacer(minLength: Spacing.sm)
                    Text(price)
                        .font(Typography.price)
                        .foregroundStyle(Palette.textPrimary)
                        .accessibilityLabel("Price \(price)")
                        .accessibilityIdentifier("saved.price")
                }
            }
        }
        .cardStyle()
    }

    private func metric(_ summary: InteractionSummary) -> some View {
        let seconds = Int(summary.active.rounded())
        let taps = summary.taps == 1 ? "1 tap" : "\(summary.taps) taps"
        return Label(
            "\(seconds) s of your time, \(taps)",
            systemImage: summary.meetsGoal ? "bolt.fill" : "timer",
        )
        .font(Typography.emphasis)
        .foregroundStyle(summary.meetsGoal ? Palette.brand : Palette.textSecondary)
        .padding(.horizontal, Spacing.sm)
        .padding(.vertical, Spacing.xs)
        .background(summary.meetsGoal ? Palette.brandSoft : Palette.surfaceSecondary, in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("saved.metric")
    }
}
