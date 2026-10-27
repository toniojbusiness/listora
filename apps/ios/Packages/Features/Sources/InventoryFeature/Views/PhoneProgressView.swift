import Core
import DesignSystem
import SwiftUI

/// The listing change this iPhone works on now: the step in plain words, its number, and about
/// how long the run has left (from the same work's earlier runs here), counting down.
struct PhoneProgressView: View {
    let progress: PhoneWorkProgress
    let marketplace: String

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            VStack(alignment: .leading, spacing: Spacing.xs) {
                HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                    Text(progress.step ?? "Starting")
                        .font(Typography.emphasis)
                        .foregroundStyle(Palette.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let count = progress.stepText {
                        Text(count)
                            .font(Typography.footnote.monospacedDigit())
                            .foregroundStyle(Palette.textSecondary)
                            .fixedSize()
                    }
                }
                if let fraction = progress.fractionDone {
                    ProgressView(value: fraction)
                        .tint(Palette.info.color)
                } else {
                    ProgressView()
                        .progressViewStyle(.linear)
                        .tint(Palette.info.color)
                }
                Text(progress.timeLeftText(at: context.date))
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(
                [progress.step ?? "Starting", progress.stepText, progress.timeLeftText(at: context.date)]
                    .compactMap(\.self).joined(separator: ", "),
            )
        }
        .padding(Spacing.sm)
        .background(Palette.infoSoft.color, in: RoundedRectangle(cornerRadius: Radius.small))
        .accessibilityIdentifier("marketplace.\(marketplace).progress")
    }
}

extension PhoneWorkProgress {
    /// "Step 4 of 9", or "Step 4" before the work ran to the end once on this phone.
    var stepText: String? {
        guard stepNumber > 0 else { return nil }
        guard let stepCount else { return "Step \(stepNumber)" }
        return "Step \(stepNumber) of \(max(stepCount, stepNumber))"
    }

    /// "Working on your iPhone, about 40 seconds left. Keep Listora open until it's done."
    func timeLeftText(at now: Date) -> String {
        let keepOpen = "Keep Listora open until it's done."
        guard let seconds = secondsLeft(at: now) else { return "Working on your iPhone. \(keepOpen)" }
        let left = seconds < 60
            ? "about \(seconds) second\(seconds == 1 ? "" : "s") left"
            : "about \(Int((Double(seconds) / 60).rounded(.up))) min left"
        return "Working on your iPhone, \(left). \(keepOpen)"
    }
}
