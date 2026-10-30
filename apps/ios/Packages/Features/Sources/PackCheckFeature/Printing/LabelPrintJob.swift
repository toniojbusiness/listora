import Core
import PDFKit
import UIKit

/// One print job of an order's shipping label and its item stickers (docs/features/pack-check.md,
/// "Printing the label"): the marketplace's label pages as they are, then the order's stickers on
/// pages of the label's size, so the label printer prints both on the same roll, in one go, and
/// the stickers that come out with a label are always that order's.
enum LabelPrintJob {
    /// A 4 × 6 in label, in points: the size of the sticker pages when the label's own can't be read.
    static let labelSize = CGSize(width: 288, height: 432)
    /// The space around the stickers on a label-size page, and between them.
    private static let margin: CGFloat = 12

    /// The label's file followed by `stickers`; `nil` when the file isn't a PDF with a page.
    static func pdf(label: Data, stickers: [StickerRequest]) -> Data? {
        guard let document = PDFDocument(data: label), document.pageCount > 0 else { return nil }
        let pages = (0 ..< document.pageCount).compactMap { document.page(at: $0) }
        let pageSize = pages.first.map { $0.bounds(for: .mediaBox).size } ?? labelSize
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(origin: .zero, size: pageSize))
        return renderer.pdfData { context in
            for page in pages {
                let bounds = page.bounds(for: .mediaBox)
                context.beginPage(withBounds: CGRect(origin: .zero, size: bounds.size), pageInfo: [:])
                let page2D = context.cgContext
                page2D.saveGState()
                // PDF pages draw bottom-up; the renderer's context is top-down.
                page2D.translateBy(x: 0, y: bounds.height)
                page2D.scaleBy(x: 1, y: -1)
                page.draw(with: .mediaBox, to: page2D)
                page2D.restoreGState()
            }
            drawStickers(stickers, pageSize: pageSize, in: context)
        }
    }

    /// The stickers stacked down label-size pages, each 2.25 × 1.25 in with a thin line to cut
    /// along, as many to a page as fit.
    private static func drawStickers(
        _ stickers: [StickerRequest],
        pageSize: CGSize,
        in context: UIGraphicsPDFRendererContext,
    ) {
        let size = StickerFormat.roll225x125.stickerSize
        let perPage = max(1, Int((pageSize.height - margin) / (size.height + margin)))
        for (offset, sticker) in stickers.enumerated() {
            let slot = offset % perPage
            if slot == 0 {
                context.beginPage(withBounds: CGRect(origin: .zero, size: pageSize), pageInfo: [:])
            }
            let origin = CGPoint(
                x: (pageSize.width - size.width) / 2,
                y: margin + CGFloat(slot) * (size.height + margin),
            )
            let rect = CGRect(origin: origin, size: size)
            UIColor.lightGray.setStroke()
            let outline = UIBezierPath(rect: rect)
            outline.lineWidth = 0.5
            outline.setLineDash([3, 3], count: 2, phase: 0)
            outline.stroke()
            StickerSheet.draw(sticker, in: rect)
        }
    }

    /// A one-page 4 × 6 in label naming `named`, for tests and the UI tests' scripted printing.
    static func testLabel(named: String) -> Data {
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(origin: .zero, size: labelSize))
        return renderer.pdfData { context in
            context.beginPage()
            ("TEST LABEL \(named)" as NSString).draw(
                at: CGPoint(x: 24, y: 24),
                withAttributes: [.font: UIFont.boldSystemFont(ofSize: 18), .foregroundColor: UIColor.black],
            )
        }
    }
}
