import Core
import DesignSystem
import SwiftUI

/// The end of a batch's review: what was saved, and the seller's time for the whole batch.
struct BatchReviewSummaryView: View {
    let summary: BatchReviewModel.Summary
    let total: Int
    let source: BatchReviewRequest.Source
    let onDone: () -> Void

    /// Where the items not approved wait.
    nonisolated static func restNote(_ source: BatchReviewRequest.Source) -> String {
        switch source {
        case .batch: "The rest stay in the batch to review later."
        case .scanRun: "The rest stay in your drafts to review later."
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 48))
                        .foregroundStyle(Palette.success)
                        .accessibilityHidden(true)
                    Text("\(summary.saved.count) of \(total) saved")
                        .font(Typography.title)
                        .foregroundStyle(Palette.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("batchSummary.saved")
                    Text(summary.saved.count < total
                        ? Self.restNote(source)
                        : "Every item is in your inventory, ready to list.")
                        .font(Typography.callout)
                        .foregroundStyle(Palette.textSecondary)
                }
                if !summary.saved.isEmpty {
                    metric
                    VStack(spacing: 0) {
                        ForEach(Array(summary.saved.enumerated()), id: \.element.sku) { index, item in
                            if index > 0 {
                                Divider().overlay(Palette.separator.color)
                            }
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.sku)
                                        .font(Typography.number)
                                        .foregroundStyle(Palette.textPrimary)
                                    if let title = item.title {
                                        Text(title)
                                            .font(Typography.subheadline)
                                            .foregroundStyle(Palette.textSecondary)
                                            .lineLimit(1)
                                    }
                                }
                                Spacer()
                                if let price = item.price {
                                    Text(price).font(Typography.price).foregroundStyle(Palette.textPrimary)
                                }
                            }
                            .padding(Spacing.sm)
                            .accessibilityElement(children: .combine)
                            .accessibilityIdentifier("batchSummary.item.\(index)")
                        }
                    }
                    .cardStyle(.flat, padding: 0)
                }
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .bottomActionBar {
            Button("Done", action: onDone)
                .buttonStyle(.listoraPrimary)
                .accessibilityIdentifier("batchSummary.done")
        }
    }

    private var metric: some View {
        let total = Self.duration(summary.active)
        let each = Self.duration(summary.averageActive)
        let taps = summary.taps == 1 ? "1 tap" : "\(summary.taps) taps"
        return Label(
            "\(total) of your time and \(taps) in all, \(each) an item",
            systemImage: summary.meetsGoal ? "bolt.fill" : "timer",
        )
        .font(Typography.callout)
        .foregroundStyle(summary.meetsGoal ? Palette.success : Palette.textSecondary)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("batchSummary.metric")
    }

    private static func duration(_ seconds: TimeInterval) -> String {
        let whole = Int(seconds.rounded())
        return whole < 60 ? "\(whole) s" : "\(whole / 60) min \(whole % 60) s"
    }
}
