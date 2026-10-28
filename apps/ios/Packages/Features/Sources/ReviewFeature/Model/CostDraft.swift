import Foundation

/// The cost screen's entries: what the seller paid, when, and where, for this item alone or as
/// its share of a haul.
struct CostDraft: Equatable {
    /// What the seller paid for this item alone, or its share of a haul (docs/features/hauls.md).
    enum Mode: Equatable {
        case item
        case haul
    }

    /// Which of a new haul's two numbers the keypad types.
    enum HaulField: Equatable {
        case total
        case count
    }

    var amount = AmountEntry()
    var purchaseDate: Date
    var source = ""
    var mode = Mode.item
    /// The saved haul the item is in or joins; nil in haul mode: a new haul, from ``haulTotal``
    /// and ``haulCount``.
    var haul: Haul?
    var haulTotal = AmountEntry()
    var haulCount = CountEntry()
    var haulField = HaulField.total

    /// Every number the chosen mode needs is entered.
    var isComplete: Bool {
        switch mode {
        case .item: amount.cents != nil
        case .haul: haul != nil || (haulTotal.cents != nil && haulCount.value != nil)
        }
    }
}
