import SwiftUI

/// Work under way in steps: the step in plain words, its number ("Step 4 of 9"), a bar (the
/// share done, or moving while the count isn't known), and a line under it that can change each
/// second ("about 40 seconds left").
public struct StepProgressView: View {
    private let step: String
    private let stepText: String?
    private let fraction: Double?
    private let detail: (Date) -> String
    private let identifier: String

    public init(
        step: String,
        stepText: String?,
        fraction: Double?,
        identifier: String,
        detail: @escaping (Date) -> String,
    ) {
        self.step = step
        self.stepText = stepText
        self.fraction = fraction
        self.identifier = identifier
        self.detail = detail
    }

    public var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            VStack(alignment: .leading, spacing: Spacing.xs) {
                HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                    Text(step)
                        .font(Typography.emphasis)
                        .foregroundStyle(Palette.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let stepText {
                        Text(stepText)
                            .font(Typography.footnote.monospacedDigit())
                            .foregroundStyle(Palette.textSecondary)
                            .fixedSize()
                    }
                }
                if let fraction {
                    ProgressView(value: fraction)
                        .tint(Palette.info.color)
                } else {
                    ProgressView()
                        .progressViewStyle(.linear)
                        .tint(Palette.info.color)
                }
                Text(detail(context.date))
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel([step, stepText, detail(context.date)].compactMap(\.self).joined(separator: ", "))
        }
        .padding(Spacing.sm)
        .background(Palette.infoSoft.color, in: RoundedRectangle(cornerRadius: Radius.small))
        .accessibilityIdentifier(identifier)
    }
}
