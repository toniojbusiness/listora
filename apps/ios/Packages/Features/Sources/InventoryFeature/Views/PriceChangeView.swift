import DesignSystem
import ListoraAPI
import SwiftUI

/// A price change for one live listing.
struct PriceChange: Identifiable, Equatable {
    let listingID: String
    /// The marketplace id (`ebay`).
    let marketplace: String
    let name: String
    let current: Money?

    var id: String {
        listingID
    }
}

/// The new price for a live listing. Saving queues the change; the item screen shows "Updating
/// price..." until the marketplace confirms it.
///
/// It warns, without refusing, when the new price is below the item's floor on that marketplace:
/// the seller would make less than their minimum after fees (`docs/features/pricing.md`).
struct PriceChangeView: View {
    let change: PriceChange
    /// The item's floor on the marketplace, loaded when the sheet opens.
    let loadFloor: () async -> Money?
    let save: (Money) -> Void
    @State private var cents: Int?
    @State private var floor: Money?
    @Environment(\.dismiss) private var dismiss

    init(change: PriceChange, loadFloor: @escaping () async -> Money?, save: @escaping (Money) -> Void) {
        self.change = change
        self.loadFloor = loadFloor
        self.save = save
        _cents = State(initialValue: change.current.map { Int($0.amountCents) })
    }

    /// "Below your $14.94 floor on eBay, ..." while the entered price is under it.
    static func floorWarning(cents: Int?, floor: Money?, marketplace: String) -> String? {
        guard let cents, cents > 0, let floor, Int64(cents) < floor.amountCents else { return nil }
        return "Below your \(Formatting.money(floor)) floor on \(marketplace), so you would make less than your "
            + "minimum after fees."
    }

    private var newPrice: Int64? {
        guard let cents, cents > 0, Int64(cents) != change.current?.amountCents else { return nil }
        return Int64(cents)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    PriceField(
                        "New price",
                        minorUnits: $cents,
                        hint: change.current.map { "Now \(Formatting.money($0)) on \(change.name)." },
                    )
                    if let warning = Self.floorWarning(cents: cents, floor: floor, marketplace: change.name) {
                        Label(warning, systemImage: "exclamationmark.triangle.fill")
                            .font(Typography.footnote)
                            .foregroundStyle(Palette.warning)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("price.belowFloor")
                    }
                }
                .padding(Spacing.md)
            }
            .task { floor = await loadFloor() }
            .background(Palette.background)
            .bottomActionBar {
                Button("Save price", systemImage: "checkmark") {
                    if let newPrice {
                        save(Money(amountCents: newPrice, currency: .usd))
                    }
                }
                .buttonStyle(.listoraPrimary)
                .disabled(newPrice == nil)
                .accessibilityIdentifier("price.save")
            }
            .navigationTitle("\(change.name) price")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
