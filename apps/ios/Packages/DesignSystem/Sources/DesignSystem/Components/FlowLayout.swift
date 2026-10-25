import SwiftUI

/// Lays its subviews out in rows, left to right, wrapping to a new row when one does not fit, so a
/// set of chips stays readable at any text size.
public struct FlowLayout: SwiftUI.Layout {
    private let spacing: CGFloat
    private let lineSpacing: CGFloat
    private let isCentered: Bool

    /// `centered` centers each row; otherwise rows start at the leading edge.
    public init(spacing: CGFloat = Spacing.xs, lineSpacing: CGFloat = Spacing.xs, centered: Bool = false) {
        self.spacing = spacing
        self.lineSpacing = lineSpacing
        isCentered = centered
    }

    public func sizeThatFits(proposal: ProposedViewSize, subviews: LayoutSubviews, cache _: inout ()) -> CGSize {
        let rows = rows(for: subviews, width: proposal.width ?? .infinity)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + lineSpacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width ?? width, height: height)
    }

    public func placeSubviews(
        in bounds: CGRect,
        proposal _: ProposedViewSize,
        subviews: LayoutSubviews,
        cache _: inout (),
    ) {
        var y = bounds.minY
        for row in rows(for: subviews, width: bounds.width) {
            var x = bounds.minX + (isCentered ? max(bounds.width - row.width, 0) / 2 : 0)
            for index in row.indices {
                let size = size(of: subviews[index], maxWidth: bounds.width)
                subviews[index].place(
                    at: CGPoint(x: x, y: y + (row.height - size.height) / 2),
                    proposal: ProposedViewSize(width: size.width, height: size.height),
                )
                x += size.width + spacing
            }
            y += row.height + lineSpacing
        }
    }

    /// The subview's natural size, or, when it is wider than a row, its size wrapped to the row's
    /// width (taller), so a long label wraps instead of being cut off.
    private func size(of subview: LayoutSubview, maxWidth: CGFloat) -> CGSize {
        let natural = subview.sizeThatFits(.unspecified)
        guard natural.width > maxWidth, maxWidth.isFinite else { return natural }
        let wrapped = subview.sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
        return CGSize(width: min(wrapped.width, maxWidth), height: wrapped.height)
    }

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func rows(for subviews: LayoutSubviews, width: CGFloat) -> [Row] {
        var rows: [Row] = []
        var current = Row()
        for index in subviews.indices {
            let size = size(of: subviews[index], maxWidth: width)
            let itemWidth = size.width
            let needed = current.indices.isEmpty ? itemWidth : current.width + spacing + itemWidth
            if needed > width, !current.indices.isEmpty {
                rows.append(current)
                current = Row()
            }
            current.width = current.indices.isEmpty ? itemWidth : current.width + spacing + itemWidth
            current.height = max(current.height, size.height)
            current.indices.append(index)
        }
        if !current.indices.isEmpty {
            rows.append(current)
        }
        return rows
    }
}
