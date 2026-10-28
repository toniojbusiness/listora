import SwiftUI

/// A price tag's outline: a card with one end cut to a point where the string ties on, the far
/// corners rounded, and, optionally, the eyelet punched through so what is behind the tag (the
/// string, the screen) shows through the hole.
///
/// `leading` tags lie on their side with the pointed end on the left, like the day's cards
/// threaded on one string; `top` tags hang from a rail with the pointed end up, like an empty
/// state's tag.
public struct TagShape: InsettableShape {
    public enum End: Sendable {
        case leading
        case top
    }

    public var end: End
    /// How deep the pointed end is cut, in points.
    public var chamfer: CGFloat
    /// The radius of the two far corners.
    public var cornerRadius: CGFloat
    /// Whether the eyelet is punched through.
    public var punchesEyelet: Bool
    private var insetAmount: CGFloat = 0

    public init(
        end: End = .leading,
        chamfer: CGFloat = TagMetrics.chamfer,
        cornerRadius: CGFloat = Radius.medium,
        punchesEyelet: Bool = true,
    ) {
        self.end = end
        self.chamfer = chamfer
        self.cornerRadius = cornerRadius
        self.punchesEyelet = punchesEyelet
    }

    public func path(in rect: CGRect) -> Path {
        let frame = rect.insetBy(dx: insetAmount, dy: insetAmount)
        guard frame.width > 0, frame.height > 0 else { return Path() }
        // An inset 45-degree cut moves in by (2 - sqrt 2) of the inset, so a stitched line stays
        // parallel to the edge.
        let cut = max(0, min(chamfer - insetAmount * (2 - 2.squareRoot()), min(frame.width, frame.height) / 2))
        let corner = max(0, cornerRadius - insetAmount)
        let point = min(Radius.tight, cut / 2)
        let vertices: [(CGPoint, CGFloat)] = switch end {
        case .leading: [
                (CGPoint(x: frame.minX + cut, y: frame.minY), point),
                (CGPoint(x: frame.maxX, y: frame.minY), corner),
                (CGPoint(x: frame.maxX, y: frame.maxY), corner),
                (CGPoint(x: frame.minX + cut, y: frame.maxY), point),
                (CGPoint(x: frame.minX, y: frame.maxY - cut), point),
                (CGPoint(x: frame.minX, y: frame.minY + cut), point),
            ]
        case .top: [
                (CGPoint(x: frame.minX, y: frame.minY + cut), point),
                (CGPoint(x: frame.minX + cut, y: frame.minY), point),
                (CGPoint(x: frame.maxX - cut, y: frame.minY), point),
                (CGPoint(x: frame.maxX, y: frame.minY + cut), point),
                (CGPoint(x: frame.maxX, y: frame.maxY), corner),
                (CGPoint(x: frame.minX, y: frame.maxY), corner),
            ]
        }
        let outline = Self.roundedPolygon(vertices)
        guard punchesEyelet, insetAmount == 0 else { return outline }
        let center = TagMetrics.eyeletCenter(in: rect, end: end)
        let radius = TagMetrics.eyeletHoleRadius
        let hole = Path(ellipseIn: CGRect(
            x: center.x - radius,
            y: center.y - radius,
            width: radius * 2,
            height: radius * 2,
        ))
        return outline.subtracting(hole)
    }

    public func inset(by amount: CGFloat) -> TagShape {
        var shape = self
        shape.insetAmount += amount
        return shape
    }

    /// A closed polygon through `vertices`, each corner rounded by its radius.
    static func roundedPolygon(_ vertices: [(CGPoint, CGFloat)]) -> Path {
        var path = Path()
        guard let last = vertices.last, let first = vertices.first else { return path }
        path.move(to: CGPoint(x: (last.0.x + first.0.x) / 2, y: (last.0.y + first.0.y) / 2))
        for (index, vertex) in vertices.enumerated() {
            let next = vertices[(index + 1) % vertices.count].0
            path.addArc(tangent1End: vertex.0, tangent2End: next, radius: vertex.1)
        }
        path.closeSubpath()
        return path
    }
}

/// The measurements every tag shares, so a screen can run its string through the eyelets.
public enum TagMetrics {
    /// How deep a tag's pointed end is cut.
    public static let chamfer: CGFloat = 22
    /// The punched hole's radius; the brass ring around it is ``eyeletRingRadius``.
    public static let eyeletHoleRadius: CGFloat = 4.5
    public static let eyeletRingRadius: CGFloat = 8
    /// How far the eyelet's center is from the pointed end: a string through a column of
    /// `leading` tags runs this far in from their left edge.
    public static let eyeletInset: CGFloat = 13

    /// Where the eyelet sits in a tag filling `rect`.
    public static func eyeletCenter(in rect: CGRect, end: TagShape.End) -> CGPoint {
        switch end {
        case .leading: CGPoint(x: rect.minX + eyeletInset, y: rect.midY)
        case .top: CGPoint(x: rect.midX, y: rect.minY + eyeletInset + 2)
        }
    }
}

extension View {
    /// A stitched line just inside `shape`, like the sewn edge of a tag, a woven label, or a
    /// leather patch. Decorative, so VoiceOver skips it.
    public func stitchedEdge(
        _ shape: some InsettableShape,
        color: some ShapeStyle = Palette.stitch,
        inset: CGFloat = 4,
    ) -> some View {
        overlay {
            shape.inset(by: inset)
                .stroke(color, style: StrokeStyle(lineWidth: 1, lineCap: .round, dash: [4, 3]))
                .accessibilityHidden(true)
        }
    }
}

/// The brass ring around a tag's punched eyelet, drawn over the hole.
struct EyeletRing: View {
    var body: some View {
        Circle()
            .strokeBorder(
                Palette.eyelet,
                lineWidth: TagMetrics.eyeletRingRadius - TagMetrics.eyeletHoleRadius,
            )
            .frame(width: TagMetrics.eyeletRingRadius * 2, height: TagMetrics.eyeletRingRadius * 2)
            .accessibilityHidden(true)
    }
}

/// Puts the view on a tag lying on its side: card stock (`surface`), the pointed end on the left
/// with its eyelet punched through, a stitched edge, and a soft shadow. The content keeps clear of
/// the pointed end. For a screen's few most important things (the day's cards); dense lists use
/// a ruled card instead (``CardKind/ruled``).
struct TagCardModifier: ViewModifier {
    let padding: CGFloat
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        let shape = TagShape(end: .leading)
        content
            .padding(.vertical, padding)
            .padding(.trailing, padding)
            .padding(.leading, TagMetrics.chamfer + Spacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.surface, in: shape)
            .overlay {
                if colorScheme == .dark {
                    shape.stroke(Palette.separator.color.opacity(0.7), lineWidth: 1)
                }
            }
            .stitchedEdge(TagShape(end: .leading, punchesEyelet: false), inset: 5)
            .overlay(alignment: .leading) {
                EyeletRing()
                    .offset(x: TagMetrics.eyeletInset - TagMetrics.eyeletRingRadius)
            }
            .elevation(.low)
    }
}

extension View {
    /// Puts the view on a tag lying on its side (`TagCardModifier`): the day's cards.
    public func tagStyle(padding: CGFloat = Spacing.md) -> some View {
        modifier(TagCardModifier(padding: padding))
    }
}

#Preview {
    VStack(spacing: Spacing.lg) {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text("Ship Carhartt Detroit Jacket").font(Typography.headline)
            Text("Sold on eBay for $120").font(Typography.subheadline).foregroundStyle(Palette.textSecondary)
        }
        .tagStyle()
        TagShape(end: .top)
            .fill(Palette.surface)
            .stitchedEdge(TagShape(end: .top, punchesEyelet: false), inset: 5)
            .frame(width: 120, height: 160)
    }
    .padding()
    .background(Palette.background)
}
