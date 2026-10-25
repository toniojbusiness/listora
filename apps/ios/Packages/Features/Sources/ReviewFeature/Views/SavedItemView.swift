import Core
import DesignSystem
import SwiftUI

/// The saved inventory item: its SKU, title, and price, and how long it took.
struct SavedItemView: View {
    let saved: ReviewFlowModel.SavedItem
    let onDone: () -> Void

    var body: some View {
        VStack(spacing: Spacing.lg) {
            Spacer(minLength: 0)
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 56, weight: .regular))
                .foregroundStyle(Palette.success)
                .accessibilityHidden(true)
            VStack(spacing: Spacing.xs) {
                Text("Saved to inventory")
                    .font(Typography.title)
                    .foregroundStyle(Palette.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                Text(saved.sku)
                    .font(Typography.largeTitle.monospacedDigit())
                    .foregroundStyle(Palette.textPrimary)
                    .textSelection(.enabled)
                    .accessibilityLabel("SKU \(saved.sku)")
                    .accessibilityIdentifier("saved.sku")
                if let title = saved.title {
                    Text(title)
                        .font(Typography.body)
                        .foregroundStyle(Palette.textSecondary)
                        .lineLimit(2)
                }
                if let price = saved.price {
                    Text(price)
                        .font(Typography.price)
                        .foregroundStyle(Palette.brand)
                        .accessibilityLabel("Price \(price)")
                        .accessibilityIdentifier("saved.price")
                }
            }
            .multilineTextAlignment(.center)
            if let summary = saved.summary {
                metric(summary)
            }
            Spacer(minLength: 0)
            Button("Done", action: onDone)
                .buttonStyle(.listoraPrimary)
                .accessibilityIdentifier("saved.done")
        }
        .padding(Spacing.lg)
        .frame(maxWidth: 480)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.background)
        .navigationTitle("Saved")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func metric(_ summary: InteractionSummary) -> some View {
        let seconds = Int(summary.active.rounded())
        let taps = summary.taps == 1 ? "1 tap" : "\(summary.taps) taps"
        return Label(
            "\(seconds) s of your time, \(taps)",
            systemImage: summary.meetsGoal ? "bolt.fill" : "timer",
        )
        .font(Typography.callout)
        .foregroundStyle(summary.meetsGoal ? Palette.success : Palette.textSecondary)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("saved.metric")
    }
}
