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

/// How a piece of string is drawn.
public enum ThreadStyle: Equatable, Sendable {
    /// Tied: a solid string.
    case taut
    /// Not tied yet (waiting its turn): a dashed string.
    case loose
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
        case .taut: StrokeStyle(lineWidth: width, lineCap: .round)
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
    private let belowDrawn: CGFloat
    private let marker: Marker
    private let content: Content
    /// The marker's frame in the row, measured, so the string runs through its center.
    @State private var markerFrame: CGRect?

    /// `below` styles the string to the next row and `belowDrawn` trims it (1 is all of it), so a
    /// string can be cut or tied.
    public init(
        position: ThreadPosition,
        above: ThreadStyle = .taut,
        below: ThreadStyle = .taut,
        belowDrawn: CGFloat = 1,
        @ViewBuilder marker: () -> Marker,
        @ViewBuilder content: () -> Content,
    ) {
        self.position = position
        self.above = above
        self.below = below
        self.belowDrawn = belowDrawn
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
                        ThreadSegment()
                            .stroke(Palette.thread, style: Thread.stroke(above))
                            .frame(width: Thread.width, height: frame.minY)
                            .offset(x: frame.midX - Thread.width / 2)
                    }
                    if position.continuesBelow {
                        ThreadSegment(drawn: belowDrawn)
                            .stroke(Palette.thread, style: Thread.stroke(below))
                            .frame(width: Thread.width, height: max(0, height - frame.maxY))
                            .offset(x: frame.midX - Thread.width / 2, y: frame.maxY)
                    }
                }
            }
            .accessibilityHidden(true)
        }
        .coordinateSpace(.named(ThreadRowSpace.name))
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
