import UIKit

/// The packing slip that goes inside the package (docs/features/pack-check.md, "Packing slip"):
/// the buyer's first name, the order number, and each item's photo and title, on a 4 × 6 in
/// label or a letter page.
struct PackingSlip: Sendable {
    struct Item: Sendable {
        let title: String
        let sku: String
        let photo: Data?
    }

    enum Format: String, CaseIterable, Identifiable, Sendable {
        case label4x6
        case letter

        var id: String {
            rawValue
        }

        var name: String {
            switch self {
            case .label4x6: "4 × 6 in label"
            case .letter: "Letter page"
            }
        }

        var pageSize: CGSize {
            switch self {
            case .label4x6: CGSize(width: 288, height: 432)
            case .letter: CGSize(width: 612, height: 792)
            }
        }
    }

    let buyerFirstName: String?
    let orderNumber: String?
    let marketplace: String
    let items: [Item]

    func pdf(format: Format) -> Data {
        let bounds = CGRect(origin: .zero, size: format.pageSize)
        return UIGraphicsPDFRenderer(bounds: bounds).pdfData { context in
            context.beginPage()
            draw(in: bounds.insetBy(dx: format == .letter ? 54 : 18, dy: format == .letter ? 54 : 18))
        }
    }

    private func draw(in rect: CGRect) {
        var y = rect.minY
        let heading = UIFont.systemFont(ofSize: 20, weight: .bold)
        let body = UIFont.systemFont(ofSize: 12)
        let small = UIFont.monospacedSystemFont(ofSize: 10, weight: .regular)
        y += line(buyerFirstName.map { "Thank you, \($0)!" } ?? "Thank you for your order!", heading, rect, y) + 6
        if let orderNumber {
            y += line("\(marketplace) order \(orderNumber)", body, rect, y) + 12
        } else {
            y += line("\(marketplace) order", body, rect, y) + 12
        }
        let photoSide = min(rect.width * 0.35, 120)
        for item in items {
            guard y + photoSide <= rect.maxY else { break }
            if let data = item.photo, let image = UIImage(data: data) {
                image.draw(in: aspectFit(image.size, in: CGRect(x: rect.minX, y: y, width: photoSide, height: photoSide)))
            }
            let textX = rect.minX + photoSide + 10
            let textRect = CGRect(x: textX, y: y, width: rect.maxX - textX, height: photoSide - 14)
            (item.title as NSString).draw(
                with: textRect,
                options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
                attributes: [.font: body, .foregroundColor: UIColor.black],
                context: nil,
            )
            _ = line(item.sku, small, CGRect(x: textX, y: 0, width: rect.maxX - textX, height: 0), y + photoSide - 12)
            y += photoSide + 12
        }
    }

    private func line(_ text: String, _ font: UIFont, _ rect: CGRect, _ y: CGFloat) -> CGFloat {
        (text as NSString).draw(
            in: CGRect(x: rect.minX, y: y, width: rect.width, height: font.lineHeight * 2),
            withAttributes: [.font: font, .foregroundColor: UIColor.black],
        )
        return font.lineHeight
    }

    private func aspectFit(_ size: CGSize, in box: CGRect) -> CGRect {
        guard size.width > 0, size.height > 0 else { return box }
        let scale = min(box.width / size.width, box.height / size.height)
        let fitted = CGSize(width: size.width * scale, height: size.height * scale)
        return CGRect(x: box.minX, y: box.minY + (box.height - fitted.height) / 2, width: fitted.width, height: fitted.height)
    }
}

/// AirPrint: the system's print sheet for a PDF, where the seller picks the printer.
@MainActor
enum Printer {
    /// Whether this device can print at all.
    static var isAvailable: Bool {
        UIPrintInteractionController.isPrintingAvailable
    }

    static func print(_ pdf: Data, jobName: String, onFinished: @escaping @MainActor (Bool) -> Void = { _ in }) {
        let info = UIPrintInfo(dictionary: nil)
        info.outputType = .grayscale
        info.jobName = jobName
        let controller = UIPrintInteractionController.shared
        controller.printInfo = info
        controller.printingItem = pdf
        controller.present(animated: true) { _, completed, _ in
            onFinished(completed)
        }
    }
}
