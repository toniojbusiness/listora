import SwiftUI
import UIKit

/// The brand loading indicator, in place of the system spinner: the Looptag l draws itself, the
/// tag lands when the string is done, then the string lifts off from its start and it begins
/// again. With Reduce Motion on, the whole mark stays still and pulses softly, as the skeletons
/// do. Its size follows `controlSize` (mini, small, regular, large), like `ProgressView`.
/// VoiceOver reads it as "In progress".
///
/// In brand colors (forest string, clay tag) by default; `color` draws both parts in one color,
/// for a spinner on a filled button or a status tone.
///
/// It runs on Core Animation (repeating layer animations, as the system spinner does) rather than
/// redrawing every frame: the render server animates it, so it costs the app nothing per frame
/// and the app still settles, which UI tests wait for.
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
        SpinnerLayerView(
            string: color ?? Palette.textPrimary,
            tag: color ?? Palette.brand,
            reduceMotion: reduceMotion,
        )
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

/// The spinner's layers: the tag and the string as shape layers in the mark's 100-unit box,
/// scaled to the view, with the cycle as repeating keyframe animations sampled from
/// `BrandSpinner.frame(at:)`.
private struct SpinnerLayerView: UIViewRepresentable {
    let string: ColorToken
    let tag: ColorToken
    let reduceMotion: Bool

    func makeUIView(context _: Context) -> SpinnerView {
        SpinnerView()
    }

    func updateUIView(_ view: SpinnerView, context _: Context) {
        view.configure(string: string.uiColor, tag: tag.uiColor, reduceMotion: reduceMotion)
    }
}

final class SpinnerView: UIView {
    private let mark = CALayer()
    private let tagLayer = CAShapeLayer()
    private let stringLayer = CAShapeLayer()
    private var stringColor = UIColor.label
    private var tagColor = UIColor.label
    private var reduceMotion = false

    /// Keyframes per cycle: enough for the eased curves to look smooth between them.
    static let keyframes = 64

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        tagLayer.path = Looptag.markTag.cgPath
        stringLayer.path = Looptag.string.cgPath
        stringLayer.fillColor = nil
        stringLayer.lineWidth = Looptag.stringWidth
        stringLayer.lineCap = .round
        stringLayer.lineJoin = .round
        mark.bounds = CGRect(x: 0, y: 0, width: 100, height: 100)
        mark.addSublayer(tagLayer)
        mark.addSublayer(stringLayer)
        layer.addSublayer(mark)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: SpinnerView, _) in
            view.applyColors()
        }
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        nil
    }

    func configure(string: UIColor, tag: UIColor, reduceMotion: Bool) {
        stringColor = string
        tagColor = tag
        applyColors()
        if reduceMotion != self.reduceMotion || mark.animationKeys() == nil {
            self.reduceMotion = reduceMotion
            startAnimating()
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let scale = bounds.width / 100
        mark.position = CGPoint(x: bounds.midX, y: bounds.midY)
        mark.setAffineTransform(CGAffineTransform(scaleX: scale, y: scale))
        CATransaction.commit()
    }

    /// Layer animations end when the view leaves a window; they start again when it is back.
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil {
            startAnimating()
        }
    }

    private func applyColors() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        stringLayer.strokeColor = stringColor.resolvedColor(with: traitCollection).cgColor
        tagLayer.fillColor = tagColor.resolvedColor(with: traitCollection).cgColor
        CATransaction.commit()
    }

    private func startAnimating() {
        for item in [mark, tagLayer, stringLayer] {
            item.removeAllAnimations()
        }
        if reduceMotion {
            stringLayer.strokeStart = 0
            stringLayer.strokeEnd = 1
            tagLayer.opacity = 1
            let pulse = ShimmerModifier.pulse
            mark.add(Self.animation("opacity", duration: 2 * pulse) {
                ShimmerModifier.pulseOpacity(at: $0 * 2 * pulse)
            }, forKey: "pulse")
            return
        }
        let cycle = BrandSpinner.cycle
        func frame(_ position: Double) -> BrandSpinner.Frame {
            BrandSpinner.frame(at: position * cycle)
        }
        stringLayer.add(Self.animation("strokeStart", duration: cycle) { Double(frame($0).start) }, forKey: "start")
        stringLayer.add(Self.animation("strokeEnd", duration: cycle) { Double(frame($0).end) }, forKey: "end")
        tagLayer.add(Self.animation("opacity", duration: cycle) { frame($0).tagOpacity }, forKey: "opacity")
        tagLayer.add(
            Self.animation("transform.translation.y", duration: cycle) { Double(frame($0).tagDrop) },
            forKey: "drop",
        )
    }

    /// A repeating keyframe animation of `keyPath` over `duration`, with `value` sampled at each
    /// keyframe's position in the cycle (0 to 1).
    static func animation(
        _ keyPath: String,
        duration: TimeInterval,
        value: (Double) -> Double,
    ) -> CAKeyframeAnimation {
        let animation = CAKeyframeAnimation(keyPath: keyPath)
        let times = (0 ... keyframes).map { Double($0) / Double(keyframes) }
        animation.keyTimes = times.map { NSNumber(value: $0) }
        // The last keyframe is the cycle's end (sampled just before it wraps to the start).
        animation.values = times.map { NSNumber(value: value(min($0, 0.999_99))) }
        animation.duration = duration
        animation.repeatCount = .infinity
        animation.calculationMode = .linear
        animation.isRemovedOnCompletion = false
        return animation
    }
}
