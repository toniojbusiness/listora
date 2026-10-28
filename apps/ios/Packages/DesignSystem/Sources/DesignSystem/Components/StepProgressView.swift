import SwiftUI

/// Work under way in steps: the step in plain words, its number ("Step 4 of 9"), a string pulled
/// taut as far as the work has come (or a moving bar while the count isn't known), and a line
/// under it that can change each second ("about 40 seconds left").
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
                    ThreadProgress(fraction: fraction)
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

/// How far work has come, as a string: taut and in the working color up to the share done, with a
/// bead where it stops, and loose (dashed) the rest of the way. Read as part of its step's label,
/// so VoiceOver skips it.
struct ThreadProgress: View {
    let fraction: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let beadSide: CGFloat = 10

    var body: some View {
        let done = min(max(fraction, 0), 1)
        GeometryReader { geometry in
            let width = geometry.size.width
            ZStack(alignment: .leading) {
                ThreadSegment(axis: .horizontal)
                    .stroke(Palette.textSecondary.color.opacity(0.5), style: Thread.stroke(.loose))
                ThreadSegment(axis: .horizontal, drawn: done)
                    .stroke(Palette.info, style: Thread.stroke(.taut))
                Circle()
                    .fill(Palette.info)
                    .frame(width: Self.beadSide, height: Self.beadSide)
                    .offset(x: (width - Self.beadSide) * done)
            }
            .frame(height: Self.beadSide)
        }
        .frame(height: Self.beadSide)
        .animation(Motion.animation(Motion.standard, reduceMotion: reduceMotion), value: done)
        .accessibilityHidden(true)
    }
}
