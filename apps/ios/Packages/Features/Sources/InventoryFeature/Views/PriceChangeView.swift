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
    @State private var text: String
    @Environment(\.dismiss) private var dismiss

    init(change: PriceChange, save: @escaping (Money) -> Void) {
        self.change = change
        self.save = save
        _text = State(initialValue: change.current.map { Formatting.editableAmount(cents: $0.amountCents) } ?? "")
    }

    private var cents: Int64? {
        Formatting.cents(from: text).flatMap { $0 > 0 ? $0 : nil }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Text("$").foregroundStyle(Palette.textSecondary)
                        TextField("0.00", text: $text)
                            .keyboardType(.decimalPad)
                            .font(Typography.price)
                            .accessibilityIdentifier("price.field")
                    }
                } footer: {
                    if let current = change.current {
                        Text("Now \(Formatting.money(current)) on \(change.name).")
                    }
                }
                .listRowBackground(Palette.surface.color)
            }
            .scrollContentBackground(.hidden)
            .background(Palette.background)
            .navigationTitle("\(change.name) price")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        if let cents {
                            save(Money(amountCents: cents, currency: .usd))
                        }
                    }
                    .disabled(cents == nil || cents == change.current?.amountCents)
                    .accessibilityIdentifier("price.save")
                }
            }
        }
        .presentationDetents([.medium])
    }
}
