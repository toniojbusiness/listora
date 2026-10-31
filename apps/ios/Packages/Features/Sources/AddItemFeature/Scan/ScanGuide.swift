import DesignSystem
import SwiftUI

/// Scan mode before the first scan, and between scans of a run: what scanning does, and the run
/// going on.
struct ScanGuide: View {
    let isCameraAvailable: Bool
    /// The run going on, if any.
    let run: ScanRunModel?
    /// The last run's summary once it was checked out, until the next run starts.
    let lastRun: SourcingRunSummary?
    /// The thrift scan is on only for the owner's Test mode.
    let isTesting: Bool

    private struct Step {
        let title: String
        let detail: String
        let systemImage: String
    }

    private static let steps = [
        Step(
            title: "One shot per item",
            detail: "The item in hand, tag showing. Hold the mic to add a note",
            systemImage: "camera.viewfinder",
        ),
        Step(
            title: "Buy, Your call, or Skip",
            detail: "From your own sales, or an AI estimate, labeled as one",
            systemImage: "tag",
        ),
        Step(
            title: "Keep what you buy",
            detail: "Keep saves a draft; shooting the next item skips this one",
            systemImage: "plus.square.on.square",
        ),
        Step(
            title: "Check out at the register",
            detail: "Enter what you paid once; see the haul's estimated profit",
            systemImage: "cart",
        ),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                HStack(spacing: Spacing.xs) {
                    Text("Scan at the bins")
                        .font(Typography.title)
                        .foregroundStyle(Palette.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                    if isTesting {
                        TestingTag()
                    }
                }
                Text(
                    isCameraAvailable
                        ? "See in seconds whether an item is worth buying to resell, without leaving the camera."
                        : "Scanning needs the camera.",
                )
                .font(Typography.body)
                .foregroundStyle(Palette.textSecondary)
            }
            if let run, !run.entries.isEmpty {
                ScanRunRow(run: run).cardStyle()
            } else if run == nil, let lastRun {
                ScanRunSummaryView(card: RunSummaryCard(lastRun))
            }
            VStack(spacing: 0) {
                ForEach(Array(Self.steps.enumerated()), id: \.offset) { index, step in
                    if index > 0 {
                        Divider().overlay(Palette.separator.color).padding(.leading, 36 + Spacing.sm)
                    }
                    ListRow(step.title, subtitle: step.detail, systemImage: step.systemImage)
                        .padding(.vertical, Spacing.xs)
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("Step \(index + 1): \(step.title). \(step.detail)")
                }
            }
            .cardStyle()
        }
        .frame(maxWidth: Layout.readableWidth, alignment: .leading)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("addItem.scanGuide")
    }
}
