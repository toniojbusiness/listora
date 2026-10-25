import APIClient
import Foundation
import ListoraAPI

/// One tap in the batch's rapid review: the item's edits, its cost, and its price saved together,
/// the same steps as the single-item flow's Continue, Continue, and Save, in order.
extension ReviewFlowModel {
    /// Saves the edits, the cost (none when nothing was entered), the price (the seller's choice,
    /// else the recommended tier after the cost's floors are known), the highest floor, and status
    /// `ready`. Returns whether the item was saved; a failure stays in ``actionError``.
    func approve() async -> Bool {
        guard saved == nil else { return true }
        commitEditing()
        let cents = cost.amount.cents
        let date = Self.day(cost.purchaseDate)
        let source = cost.source.trimmingCharacters(in: .whitespacesAndNewlines)
        var savedDetails = false
        await perform { () async throws(APIFailure) in
            try await saveEdits()
            if let cents {
                _ = try await replace { _, details in
                    var details = details
                    details.cost = Money(amountCents: cents, currency: .usd)
                    details.purchaseDate = date
                    details.purchaseSource = source.isEmpty ? nil : source
                    return details
                }
                if !source.isEmpty {
                    recentSources.remember(source)
                }
            }
            savedDetails = true
        }
        guard savedDetails else { return false }
        // The floors depend on the cost just saved.
        await loadPricing()
        if case let .failed(message) = pricing {
            actionError = message
            return false
        }
        await save()
        return saved != nil
    }

    /// The price the item will be saved at, as the review shows it before the tap.
    var chosenPriceLabel: String? {
        chosenCents.map { Formatting.money(cents: $0) }
    }
}
