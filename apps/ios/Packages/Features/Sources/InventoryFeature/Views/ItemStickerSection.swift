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
