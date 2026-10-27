import Core
import CoreImage
import CoreImage.CIFilterBuiltins
import UIKit

/// The sizes Listora prints item stickers on: the common label printers' rolls, and plain
/// letter sheets of address labels, through AirPrint (docs/features/pack-check.md, "Item
/// stickers").
enum StickerFormat: String, CaseIterable, Identifiable, Sendable {
    /// 2.25 × 1.25 in: Dymo 30334, Rollo, Zebra, Munbyn rolls.
    case roll225x125
    /// 2.125 × 1 in: Dymo 30336 and small Brother rolls.
    case roll2125x1
    /// Letter, 30 per page (Avery 5160 and the same address labels).
    case sheet30

    var id: String {
        rawValue
    }

    var name: String {
        switch self {
        case .roll225x125: "Label roll, 2.25 × 1.25 in"
        case .roll2125x1: "Label roll, 2.125 × 1 in"
        case .sheet30: "Letter sheet, 30 per page"
        }
    }

    var detail: String {
        switch self {
        case .roll225x125: "Dymo 30334, Rollo, Zebra, Munbyn"
        case .roll2125x1: "Dymo 30336, Brother"
        case .sheet30: "Avery 5160 and other address labels"
        }
    }

    /// One sticker's size in points (72 per inch).
    var stickerSize: CGSize {
        switch self {
        case .roll225x125: CGSize(width: 162, height: 90)
        case .roll2125x1: CGSize(width: 153, height: 72)
        case .sheet30: CGSize(width: 189, height: 72)
        }
    }

    /// The page: one sticker on a roll, a letter sheet otherwise.
    var pageSize: CGSize {
        self == .sheet30 ? CGSize(width: 612, height: 792) : stickerSize
    }
}

/// Item stickers as a PDF to print: each a QR code (`LISTORA:<SKU>`), the SKU, the shelf, and the
/// title, sized for the format.
enum StickerSheet {
    /// Avery 5160's layout: 3 columns of 10, from the sheet's top left corner.
    private static let sheetOrigin = CGPoint(x: 13.5, y: 36)
    private static let sheetPitch = CGSize(width: 198, height: 72)

    static func pdf(_ stickers: [StickerRequest], format: StickerFormat) -> Data {
        let bounds = CGRect(origin: .zero, size: format.pageSize)
        let renderer = UIGraphicsPDFRenderer(bounds: bounds)
        return renderer.pdfData { context in
            switch format {
            case .roll225x125, .roll2125x1:
                for sticker in stickers {
                    context.beginPage()
                    draw(sticker, in: bounds)
                }
            case .sheet30:
                for (offset, sticker) in stickers.enumerated() {
                    let slot = offset % 30
                    if slot == 0 { context.beginPage() }
                    let origin = CGPoint(
                        x: sheetOrigin.x + CGFloat(slot % 3) * sheetPitch.width,
                        y: sheetOrigin.y + CGFloat(slot / 3) * sheetPitch.height,
                    )
                    draw(sticker, in: CGRect(origin: origin, size: format.stickerSize))
                }
            }
        }
    }

    /// One sticker: the QR code on the left, the words on the right.
    static func draw(_ sticker: StickerRequest, in rect: CGRect) {
        let inset = rect.insetBy(dx: 6, dy: 6)
        let side = inset.height
        if let qr = qrImage(sticker.code, side: side) {
            qr.draw(in: CGRect(x: inset.minX, y: inset.minY, width: side, height: side))
        }
        let text = CGRect(x: inset.minX + side + 6, y: inset.minY, width: inset.width - side - 6, height: inset.height)
        let skuFont = UIFont.monospacedSystemFont(ofSize: min(14, side / 4.2), weight: .bold)
        let shelfFont = UIFont.systemFont(ofSize: min(11, side / 5.5), weight: .semibold)
        let titleFont = UIFont.systemFont(ofSize: min(8, side / 7.5))
        var y = text.minY
        y += drawLine(sticker.sku, font: skuFont, x: text.minX, y: y, width: text.width)
        if let shelf = sticker.locationCode, !shelf.isEmpty {
            y += drawLine("Shelf \(shelf)", font: shelfFont, x: text.minX, y: y + 2, width: text.width) + 2
        }
        if let title = sticker.title, !title.isEmpty {
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineBreakMode = .byTruncatingTail
            let remaining = CGRect(x: text.minX, y: y + 2, width: text.width, height: max(0, text.maxY - y - 2))
            (title as NSString).draw(
                with: remaining,
                options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
                attributes: [.font: titleFont, .foregroundColor: UIColor.black, .paragraphStyle: paragraph],
                context: nil,
            )
        }
    }

    private static func drawLine(_ text: String, font: UIFont, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font, .foregroundColor: UIColor.black, .paragraphStyle: paragraph,
        ]
        (text as NSString).draw(in: CGRect(x: x, y: y, width: width, height: font.lineHeight), withAttributes: attributes)
        return font.lineHeight
    }

    /// A sharp QR code of `text`, `side` points square.
    static func qrImage(_ text: String, side: CGFloat) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        // Scaled by whole pixels at print resolution, so every module stays square and crisp.
        let scale = max(1, (side * 4 / output.extent.width).rounded(.down))
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let image = CIContext().createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: image)
    }
}
