import DesignSystem
import SwiftUI

/// How the marketplace has the order shipped, in the server's words (`PackOrder.shippingNote`),
/// for information: Vinted's five business days to ship, the extra days the seller can ask the
/// buyer for in Vinted, and a QR code shown at the carrier's counter. Nothing when it says none.
struct ShippingNote: View {
    let order: PackOrder

    var body: some View {
        if let note = order.shippingNote, !note.isEmpty {
            Label(note, systemImage: "info.circle")
                .font(Typography.subheadline)
                .foregroundStyle(Palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("pack.shippingNote")
        }
    }
}
