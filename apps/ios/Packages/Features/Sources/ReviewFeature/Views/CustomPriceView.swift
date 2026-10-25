import DesignSystem
import SwiftUI

/// The seller's own price on the keypad, with the floors to stay above. The keypad and Use sit at
/// the bottom, within thumb reach.
struct CustomPriceView: View {
    let presentation: PricingPresentation?
    let onDone: (Int64) -> Void
    @State private var entry: AmountEntry
    @Environment(\.dismiss) private var dismiss

    init(initial: Int64?, presentation: PricingPresentation?, onDone: @escaping (Int64) -> Void) {
        self.presentation = presentation
        self.onDone = onDone
        _entry = State(initialValue: initial.map(AmountEntry.init(cents:)) ?? AmountEntry())
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: Spacing.lg) {
                    VStack(spacing: Spacing.xs) {
                        AmountDisplay(entry: entry, label: "Price", identifier: "price.customAmount")
                        floorHint
                    }
                    KeypadView { entry.press($0) }
                }
                .padding(Spacing.md)
                .frame(maxWidth: Layout.readableWidth)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .scrollBounceBehavior(.basedOnSize)
            .background(Palette.background)
            .navigationTitle("Your price")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .bottomActionBar {
                Button {
                    if let cents = entry.cents {
                        onDone(cents)
                    }
                    dismiss()
                } label: {
                    if let cents = entry.cents, cents > 0 {
                        Text("Use \(Formatting.money(cents: cents))")
                    } else {
                        Text("Use this price")
                    }
                }
                .buttonStyle(.listoraPrimary)
                .disabled((entry.cents ?? 0) <= 0)
                .accessibilityIdentifier("price.customUse")
            }
        }
    }

    /// The highest floor, or which floors the typed price is under.
    @ViewBuilder
    private var floorHint: some View {
        if let presentation, let highest = presentation.highestFloor {
            if let cents = entry.cents, let warning = presentation.shortWarning(for: cents) {
                Label(warning, systemImage: "exclamationmark.triangle.fill")
                    .font(Typography.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.warning)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("price.customBelowFloor")
            } else {
                Text("Don't sell below \(highest.price) on \(highest.name)")
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .multilineTextAlignment(.center)
            }
        }
    }
}
