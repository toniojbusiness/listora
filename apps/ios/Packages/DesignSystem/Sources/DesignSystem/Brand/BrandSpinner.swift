import SwiftUI

/// The brand loading indicator, in place of the system spinner: the Looptag l draws itself, the
/// tag lands when the string is done, then the string lifts off from its start and it begins
/// again. With Reduce Motion on, the whole mark stays still and pulses softly, as the skeletons
/// do. Its size follows `controlSize` (mini, small, regular, large), like `ProgressView`.
/// VoiceOver reads it as "In progress".
///
/// In brand colors (forest string, clay tag) by default; `color` draws both parts in one color,
/// for a spinner on a filled button or a status tone.
public struct BrandSpinner: View {
    private let color: ColorToken?

    @Environment(\.controlSize) private var controlSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(color: ColorToken? = nil) {
        self.color = color
    }

    /// One cycle: draw, hold with the tag on, lift off.
    nonisolated static let cycle: TimeInterval = 1.6

    public var body: some View {
        let side = Self.side(for: controlSize)
        TimelineView(.animation) { timeline in
            let time = timeline.date.timeIntervalSinceReferenceDate
            let frame = reduceMotion ? Frame.still : Self.frame(at: time)
            Canvas { context, size in
                let scale = size.width / 100
                context.scaleBy(x: scale, y: scale)
                if frame.tagOpacity > 0 {
                    var tagContext = context
                    tagContext.opacity = frame.tagOpacity
                    tagContext.translateBy(x: 0, y: frame.tagDrop)
                    tagContext.fill(Looptag.markTag, with: .style(color ?? Palette.brand))
                }
                if frame.end > frame.start {
                    context.fill(
                        Looptag.stroke(from: frame.start, to: frame.end),
                        with: .style(color ?? Palette.textPrimary),
                    )
                }
            }
            .opacity(reduceMotion ? ShimmerModifier.pulseOpacity(at: time) : 1)
        }
        .frame(width: side, height: side)
        .accessibilityElement()
        .accessibilityLabel("In progress")
    }

    /// The mark's box, in points, per control size: about the system spinner's footprint.
    nonisolated static func side(for controlSize: ControlSize) -> CGFloat {
        switch controlSize {
        case .mini: 14
        case .small: 18
        case .regular: 24
        case .large, .extraLarge: 36
        @unknown default: 24
        }
    }

    /// What the spinner shows at one moment: the drawn part of the string (`start` to `end`, 0 to
    /// 1 of its length), and the tag's opacity and how far above its place it is (in the mark's
    /// 100-unit box).
    struct Frame: Equatable {
        var start: CGFloat
        var end: CGFloat
        var tagOpacity: Double
        var tagDrop: CGFloat

        /// The whole mark, for Reduce Motion.
        static let still = Frame(start: 0, end: 1, tagOpacity: 1, tagDrop: 0)
    }

    /// The share of the cycle the string takes to draw, then the moment it starts to lift off.
    nonisolated static let drawn = 0.55
    nonisolated static let liftOff = 0.8
    /// How long the tag takes to land, as a share of the cycle, and the height it drops from.
    nonisolated static let landing = 0.12
    nonisolated static let dropHeight: CGFloat = 8

    nonisolated static func frame(at time: TimeInterval) -> Frame {
        let position = time.truncatingRemainder(dividingBy: cycle) / cycle
        if position < drawn {
            return Frame(start: 0, end: eased(position / drawn), tagOpacity: 0, tagDrop: 0)
        }
        if position < liftOff {
            let landed = min((position - drawn) / landing, 1)
            return Frame(start: 0, end: 1, tagOpacity: landed, tagDrop: -dropHeight * (1 - eased(landed)))
        }
        let lifted = eased((position - liftOff) / (1 - liftOff))
        return Frame(start: lifted, end: 1, tagOpacity: 1 - lifted, tagDrop: 0)
    }

    /// Ease in and out (smoothstep).
    nonisolated private static func eased(_ value: Double) -> CGFloat {
        CGFloat(value * value * (3 - 2 * value))
    }
}
