import SwiftUI

/// Where a row sits on a string: the string comes in from the row above unless the row is the
/// first, and goes on to the row below unless it is the last.
public enum ThreadPosition: Equatable, Sendable {
    case first
    case middle
    case last
    /// The only row: a bead on its own, with no string.
    case only

    /// The position of row `index` of `count`.
    public static func at(_ index: Int, of count: Int) -> ThreadPosition {
        switch (index == 0, index == count - 1) {
        case (true, true): .only
        case (true, false): .first
        case (false, true): .last
        case (false, false): .middle
        }
    }

    var continuesAbove: Bool {
        self == .middle || self == .last
    }

    var continuesBelow: Bool {
        self == .first || self == .middle
    }
}

/// How a piece of string is drawn. Screens pick it from confirmed states only, so a knot is tied
/// once a marketplace confirms a listing, and a string is cut once it confirms the listing ended.
public enum ThreadStyle: Equatable, Sendable {
    /// Tied: a solid string.
    case taut
    /// Not tied yet (waiting its turn, or still in progress): a dashed string.
    case loose
    /// Cut: snipped in the middle, with the scissors' mark in the gap.
    case cut
}

/// A straight piece of the Looptag string from the top to the bottom of its frame (or from the
/// leading to the trailing edge, horizontally). `drawn` trims it, from 0 (nothing) to 1 (all of
/// it), so it can be cut or tied in an animation.
public struct ThreadSegment: Shape {
    public var axis: Axis
    public var drawn: CGFloat

    public init(axis: Axis = .vertical, drawn: CGFloat = 1) {
        self.axis = axis
        self.drawn = drawn
    }

    public var animatableData: CGFloat {
        get { drawn }
        set { drawn = newValue }
    }

    public func path(in rect: CGRect) -> Path {
        var path = Path()
        switch axis {
        case .vertical:
            path.move(to: CGPoint(x: rect.midX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.midX, y: rect.minY + rect.height * drawn))
        case .horizontal:
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.minX + rect.width * drawn, y: rect.midY))
        }
        return path
    }
}

/// The string's stroke.
public enum Thread {
    public static let width: CGFloat = 2

    /// How a piece of string in `style` is stroked.
    public static func stroke(_ style: ThreadStyle) -> StrokeStyle {
        switch style {
        case .taut, .cut: StrokeStyle(lineWidth: width, lineCap: .round)
        case .loose: StrokeStyle(lineWidth: width, lineCap: .round, dash: [3, 5])
        }
    }
}

/// A bead on the string: one marketplace (or one step) and how it stands, shown three ways so
/// nothing relies on color alone: the fill (filled when confirmed or failed, a ring while work
/// runs or the seller is needed, a dashed ring while it waits), the letter, and a small badge
/// with the tone's symbol. Decorative next to the status in words, so VoiceOver skips it.
public struct ThreadBead: View {
    private let monogram: String
    private let tone: StatusTone
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1
    /// Toggled when the marketplace confirms, so the bead pulls tight like a knot being tied.
    @State private var knot = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The bead's side at the default text size; it grows a little with the text.
    public static let side: CGFloat = 30

    public init(monogram: String, tone: StatusTone) {
        self.monogram = monogram
        self.tone = tone
    }

    /// The side at this text size: up to 1.4 times ``side``, so a string of beads stays a string.
    var scaledSide: CGFloat {
        Self.side * min(max(scale, 1), 1.4)
    }

    private var isFilled: Bool {
        tone == .success || tone == .failed
    }

    public var body: some View {
        let side = scaledSide
        ZStack {
            if isFilled {
                Circle().fill(tone.color)
            } else {
                Circle().fill(Palette.surface)
                Circle().strokeBorder(
                    tone == .neutral ? Palette.textSecondary.color : tone.color.color,
                    style: StrokeStyle(lineWidth: 2, dash: tone == .neutral ? [3, 3] : []),
                )
            }
            Text(monogram)
                .font(.system(size: side * 0.45, weight: .bold))
                .foregroundStyle(isFilled ? Palette.surface : (tone == .neutral ? Palette.textSecondary : tone.color))
        }
        .frame(width: side, height: side)
        .overlay(alignment: .bottomTrailing) {
            if tone != .neutral {
                Image(systemName: tone.systemImage)
                    .font(.system(size: side * 0.36, weight: .bold))
                    .foregroundStyle(tone.color)
                    .background(Circle().fill(Palette.surface).padding(-1.5))
                    .offset(x: side * 0.12, y: side * 0.08)
            }
        }
        .keyframeAnimator(initialValue: 1.0, trigger: knot) { bead, scale in
            bead.scaleEffect(scale)
        } keyframes: { _ in
            SpringKeyframe(1.22, duration: 0.16)
            SpringKeyframe(1.0, duration: 0.34)
        }
        .animation(Motion.animation(Motion.standard, reduceMotion: reduceMotion), value: tone)
        .onChange(of: tone) { old, new in
            // A knot is tied only when the marketplace confirms; no movement with Reduce Motion.
            if new == .success, old != .success, !reduceMotion {
                knot.toggle()
            }
        }
        .accessibilityHidden(true)
    }
}

/// A row on a string: a marker (a ``ThreadBead``, an eyelet) in a leading column, the content
/// beside it, and the string running through the marker's center to the rows above and below.
/// Each row draws only its own pieces of string, so a column of rows with no spacing between
/// them reads as one string with no geometry shared across rows.
public struct ThreadRow<Marker: View, Content: View>: View {
    private let position: ThreadPosition
    private let above: ThreadStyle
    private let below: ThreadStyle
    private let marker: Marker
    private let content: Content
    /// The marker's frame in the row, measured, so the string runs through its center.
    @State private var markerFrame: CGRect?

    /// `above` styles the string from the row above and `below` the string to the next row. A
    /// change of style animates: a loose string is tied from the top down, a taut one is snipped.
    /// Only `above` shows the cut, so a cut string has one gap.
    public init(
        position: ThreadPosition,
        above: ThreadStyle = .taut,
        below: ThreadStyle = .taut,
        @ViewBuilder marker: () -> Marker,
        @ViewBuilder content: () -> Content,
    ) {
        self.position = position
        self.above = above
        self.below = below
        self.marker = marker()
        self.content = content()
    }

    public var body: some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            marker
                .onGeometryChange(for: CGRect.self) { proxy in
                    proxy.frame(in: .named(ThreadRowSpace.name))
                } action: { markerFrame = $0 }
            content
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, Spacing.xs)
        .background {
            GeometryReader { geometry in
                if let frame = markerFrame {
                    let height = geometry.size.height
                    if position.continuesAbove {
                        ThreadPiece(style: above)
                            .frame(width: ThreadPiece.width, height: frame.minY)
                            .offset(x: frame.midX - ThreadPiece.width / 2)
                    }
                    if position.continuesBelow {
                        // The cut shows once, above the bead it frees.
                        ThreadPiece(style: below == .cut ? .taut : below)
                            .frame(width: ThreadPiece.width, height: max(0, height - frame.maxY))
                            .offset(x: frame.midX - ThreadPiece.width / 2, y: frame.maxY)
                    }
                }
            }
            .accessibilityHidden(true)
        }
        .coordinateSpace(.named(ThreadRowSpace.name))
    }
}

/// One piece of string in its style, animating as the style changes: a loose string is tied by a
/// taut one running down over it, and a taut string is snipped open in the middle with the
/// scissors' mark in the gap. With Reduce Motion, each change is one cross-fade.
struct ThreadPiece: View {
    let style: ThreadStyle
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Wide enough for the scissors in a cut.
    static let width: CGFloat = 16

    var body: some View {
        Group {
            if reduceMotion {
                drawing.id(style).transition(.opacity)
            } else {
                drawing
            }
        }
        .animation(reduceMotion ? Motion.reduced : Motion.gentle, value: style)
        .accessibilityHidden(true)
    }

    private var drawing: some View {
        ZStack {
            if style != .cut {
                ThreadSegment()
                    .stroke(Palette.thread, style: Thread.stroke(.loose))
            }
            SnippedString(tied: style == .loose ? 0 : 1, cut: style == .cut ? 1 : 0)
                .stroke(Palette.thread, style: Thread.stroke(.taut))
            Image(systemName: "scissors")
                .font(.system(size: 11, weight: .semibold))
                .rotationEffect(.degrees(90))
                .foregroundStyle(Palette.textSecondary)
                .opacity(style == .cut ? 1 : 0)
        }
        .frame(width: Self.width)
    }
}

/// A vertical string drawn solid from the top down `tied` of its length, with a gap opened in its
/// middle as `cut` goes from 0 to 1. Both animate.
struct SnippedString: Shape {
    var tied: CGFloat
    var cut: CGFloat

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(tied, cut) }
        set {
            tied = newValue.first
            cut = newValue.second
        }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let end = rect.minY + rect.height * tied
        let gap = cut * min(rect.height * 0.5, 18)
        let top = rect.midY - gap / 2, bottom = rect.midY + gap / 2
        func line(_ start: CGFloat, _ finish: CGFloat) {
            guard finish > start else { return }
            path.move(to: CGPoint(x: rect.midX, y: start))
            path.addLine(to: CGPoint(x: rect.midX, y: finish))
        }
        if gap > 0 {
            line(rect.minY, min(top, end))
            line(bottom, end)
        } else {
            line(rect.minY, end)
        }
        return path
    }
}

private enum ThreadRowSpace {
    static let name = "ThreadRow"
}

#Preview {
    let tones: [StatusTone] = [.success, .success, .inProgress, .neutral]
    let labels = [
        "Active (confirmed by eBay)",
        "Active (confirmed by Depop)",
        "Listing on Poshmark...",
        "Waiting its turn",
    ]
    let monograms = ["e", "D", "P", "M"]
    VStack(spacing: 0) {
        ForEach(tones.indices, id: \.self) { index in
            ThreadRow(position: .at(index, of: tones.count), below: index >= 2 ? .loose : .taut) {
                ThreadBead(monogram: monograms[index], tone: tones[index])
            } content: {
                StatusLabel(labels[index], tone: tones[index])
            }
        }
    }
    .padding()
    .background(Palette.background)
}
