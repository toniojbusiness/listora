import Core
import DesignSystem
import SwiftUI

/// Under an order, on the to-ship list and in its packing session: its stickers to print, and its
/// label with them, or the order's page on the marketplace where Listora can't print its label.
struct OrderPrintActions: View {
    let order: PackOrder
    let environment: PackCheckEnvironment
    /// Gets the order back after a print is recorded.
    let onChange: @MainActor (PackOrder) -> Void
    @State private var printingStickers: StickerBatch?
    @State private var printingLabel: LabelPrintModel?

    var body: some View {
        let key = order.items.first?.sku ?? order.saleId
        let stickers = order.items.map(StickerRequest.init)
        HStack(spacing: Spacing.sm) {
            Button {
                printingStickers = StickerBatch(stickers: stickers)
            } label: {
                Label(stickers.count == 1 ? "Print sticker" : "Print \(stickers.count) stickers", systemImage: "qrcode")
            }
            .buttonStyle(ListoraButtonStyle(.secondary, size: .compact))
            .accessibilityIdentifier("pack.printStickers.\(key)")
            if order.label?.fileUrl != nil {
                Button {
                    printingLabel = environment.makeLabelPrint(order, onChange: onChange)
                } label: {
                    Label("Print label and stickers", systemImage: "printer")
                }
                .buttonStyle(ListoraButtonStyle(.secondary, size: .compact))
                .accessibilityIdentifier("pack.printLabel.\(key)")
            } else if let page = order.labelPageUrl.flatMap(URL.init(string:)) {
                Link(destination: page) {
                    Label(
                        "Open label on \(MarketplaceName.of(order.marketplace))",
                        systemImage: "arrow.up.right.square",
                    )
                }
                .buttonStyle(ListoraButtonStyle(.secondary, size: .compact))
                .accessibilityIdentifier("pack.openLabel.\(key)")
            }
        }
        .sheet(item: $printingStickers) { batch in StickerPrintView(stickers: batch.stickers) }
        .sheet(item: $printingLabel) { print in LabelPrintView(model: print) }
    }
}
