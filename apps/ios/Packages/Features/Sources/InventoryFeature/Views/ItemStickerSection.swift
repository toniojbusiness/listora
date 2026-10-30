import Core
import DesignSystem
import SwiftUI

/// The item's SKU sticker for its bag, which Pack check scans at packing
/// (docs/features/pack-check.md): "Print sticker", and just after listing, an offer to print it.
struct ItemStickerSection: View {
    @Binding var offers: Bool
    let onPrint: @MainActor () -> Void

    var body: some View {
        if offers {
            Banner(
                "Print its sticker?",
                message: "Stick it on the item's bag. Scanning it when you pack makes sure the right item ships.",
                tone: .neutral,
                systemImage: "qrcode",
                action: .init("Print sticker", identifier: "item.stickerNudge") {
                    offers = false
                    onPrint()
                },
                onDismiss: { offers = false },
            )
        }
        Button("Print sticker", systemImage: "qrcode", action: onPrint)
            .buttonStyle(.listoraSecondary)
            .accessibilityIdentifier("item.printSticker")
    }
}

extension StickerRequest {
    /// The item's sticker: its SKU, title, and shelf.
    init(_ item: Item) {
        self.init(sku: item.sku, title: item.details.title, locationCode: item.storageLocation?.code)
    }
}

/// "Mark as sold", for an item that is not sold yet.
struct MarkSoldButton: View {
    let item: Item
    @Binding var request: MarkSoldRequest?

    var body: some View {
        if item.canBeMarkedSold {
            Button("Mark as sold", systemImage: "dollarsign.circle") {
                request = MarkSoldRequest(
                    itemID: item.id,
                    sku: item.sku,
                    title: item.details.title,
                    listPriceCents: item.details.listPrice?.amountCents,
                    listedOn: item.listings
                        .filter { $0.status.value1 == .active }
                        .compactMap { $0.marketplace.value1?.rawValue },
                )
            }
            .buttonStyle(.listoraSecondary)
            .accessibilityIdentifier("item.markSold")
        }
    }
}
