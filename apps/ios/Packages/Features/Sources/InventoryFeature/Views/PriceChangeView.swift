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
struct PriceChangeView: View {
    let change: PriceChange
    let save: (Money) -> Void
    @State private var cents: Int?
    @Environment(\.dismiss) private var dismiss

    init(change: PriceChange, save: @escaping (Money) -> Void) {
        self.change = change
        self.save = save
        _cents = State(initialValue: change.current.map { Int($0.amountCents) })
    }

    private var newPrice: Int64? {
        guard let cents, cents > 0, Int64(cents) != change.current?.amountCents else { return nil }
        return Int64(cents)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                PriceField(
                    "New price",
                    minorUnits: $cents,
                    hint: change.current.map { "Now \(Formatting.money($0)) on \(change.name)." },
                )
                .padding(Spacing.md)
            }
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
