import DesignSystem
import SwiftUI

/// "How Pack check works", in four steps: the sticker, the label and its stickers printed
/// together, the scan of both at the packing table, and the double-print guard. On Settings >
/// Pack check, and once the first time the to-ship list opens (then from its "How it works").
struct PackCheckExplainer: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            step(
                1,
                "qrcode",
                "A sticker for each item",
                "Print it from the item's screen (Print sticker) when you list it, and stick it on the "
                    + "item's bag. Its QR code is the item's SKU.",
            )
            step(
                2,
                "printer",
                "The label and its stickers, together",
                "When it sells, Pack orders shows the order. Print label and stickers prints the "
                    + "marketplace's shipping label with that order's stickers in one go, so they always "
                    + "match. Where Listora can't get a marketplace's label, Open label takes you to the "
                    + "order there to print it.",
            )
            step(
                3,
                "barcode.viewfinder",
                "Scan both when you pack",
                "Scan the label's barcode, then the item's sticker. Green means it's this order's "
                    + "package. A red stop means the label is another order's, or one you already used.",
            )
            step(
                4,
                "checkmark.seal",
                "A second copy is caught",
                "Listora remembers which label went on which package, and asks before it prints a "
                    + "label again, so a printer that prints twice never ships one buyer two packages.",
            )
            Text("Pack check only reads your marketplaces. It never changes a listing or an order.")
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("packCheck.explainer")
    }

    private func step(_ number: Int, _ systemImage: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            Image(systemName: systemImage)
                .foregroundStyle(Palette.brand.color)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text("\(number). \(title)").font(Typography.headline)
                Text(detail)
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// Whether the to-ship list showed it already, on this phone.
    static let seenKey = "packCheck.explainerSeen"

    static func resetLocalData(defaults: UserDefaults) {
        defaults.removeObject(forKey: seenKey)
    }
}

/// The explainer as a sheet over the to-ship list.
struct PackCheckExplainerSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                PackCheckExplainer()
                    .padding(Spacing.md)
                    .frame(maxWidth: Layout.readableWidth)
                    .frame(maxWidth: .infinity)
            }
            .background(Palette.background)
            .navigationTitle("How Pack check works")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Got it") { dismiss() }
                        .accessibilityIdentifier("packCheck.explainer.done")
                }
            }
        }
    }
}
