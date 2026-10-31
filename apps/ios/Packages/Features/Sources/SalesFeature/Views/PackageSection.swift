import DesignSystem
import ListoraAPI
import SwiftUI

/// The sale's package once packed (Pack check): when, and how its label matched, in the server's
/// words; "Open package" shows it in Pack check, to add its photo, print its slip, or unpack it.
struct PackageSection: View {
    let order: Components.Schemas.PackOrder
    let open: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader("Package")
            VStack(alignment: .leading, spacing: Spacing.sm) {
                StatusBadge(order.packStatus.label, tone: StatusTone(order.packStatus.tone))
                    .accessibilityIdentifier("sale.package.status")
                Text(order.labelStatus.label)
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                if order.pack?.photoUrl != nil {
                    Label("Package photo kept for a claim", systemImage: "camera")
                        .font(Typography.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                }
                Button("Open package", systemImage: "shippingbox", action: open)
                    .buttonStyle(.listora(.tertiary, size: .compact))
                    .accessibilityIdentifier("sale.package.open")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardStyle(.ruled)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sale.package")
    }
}
