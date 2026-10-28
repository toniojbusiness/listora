import APIClient
import Foundation
import ListoraAPI

/// The cost screen's two ways to say what the item cost (docs/features/hauls.md): this item's own
/// price, or its share of a haul, such as 30 items from the bins for $50. The server keeps a haul
/// item's cost at its share, so the app joins or creates the haul and reads the item back.
extension ReviewFlowModel {
    /// Reads the seller's latest hauls for the cost screen. A failure only leaves them out: a new
    /// haul can still be entered.
    func loadHauls() async {
        do {
            recentHauls = try await service.hauls()
        } catch {
            log.error("Hauls failed: \(error.code, privacy: .public)")
        }
    }

    /// Saves what the cost screen says. Skipping clears the cost (and takes the item out of its
    /// haul). This item: leaves its haul if it is in one, then saves the amount, date, and source;
    /// nothing is written while no amount is entered. A haul: joins the chosen haul, or creates the
    /// new one with this item in it, then reads the item back with its share as its cost.
    func saveCost(skipping: Bool = false) async throws(APIFailure) {
        let date = Self.day(cost.purchaseDate)
        let source = cost.source.trimmingCharacters(in: .whitespacesAndNewlines)
        if skipping {
            try await leaveHaul()
            _ = try await replace { _, details in
                var details = details
                details.cost = nil
                return details
            }
            return
        }
        // The place the seller typed is remembered when it was saved: with this item, or the new haul.
        var savedSource = false
        switch cost.mode {
        case .item:
            guard let cents = cost.amount.cents else { return }
            try await leaveHaul()
            _ = try await replace { _, details in
                var details = details
                details.cost = Money(amountCents: cents, currency: .usd)
                details.purchaseDate = date
                details.purchaseSource = source.isEmpty ? nil : source
                return details
            }
            savedSource = true
        case .haul:
            if let haul = cost.haul {
                if item?.haul?.id != haul.id {
                    _ = try await service.addHaulItems(
                        haulID: haul.id,
                        itemIDs: [request.itemID],
                        idempotencyKey: UUID().uuidString.lowercased(),
                    )
                }
            } else {
                try await createHaul(date: date, source: source)
                savedSource = true
            }
            try await readHaulCost()
        }
        if savedSource, !source.isEmpty {
            recentSources.remember(source)
        }
    }

    /// Fixes the chosen haul's count (``CostDraft/haulCount``): every item in it gets its new share.
    func fixHaulCount() async {
        guard let haul = cost.haul, let count = cost.haulCount.value else { return }
        await perform { () async throws(APIFailure) in
            let fixed = try await service.replaceHaul(
                haulID: haul.id,
                with: HaulReplace(
                    total: haul.total,
                    itemCount: Int32(count),
                    purchaseDate: haul.purchaseDate,
                    purchaseSource: haul.purchaseSource,
                ),
            )
            cost.haul = fixed
            replaceRecent(fixed)
            if item?.haul?.id == fixed.id {
                try await readHaulCost()
            }
        }
    }

    /// The new haul from the entered total and count, with this item in it. A retry of the same
    /// haul reuses its Idempotency-Key, so the server records it once.
    private func createHaul(date: String, source: String) async throws(APIFailure) {
        guard let total = cost.haulTotal.cents, let count = cost.haulCount.value else { return }
        let body = HaulCreate(
            total: Money(amountCents: total, currency: .usd),
            itemCount: Int32(count),
            purchaseDate: date,
            purchaseSource: source.isEmpty ? nil : source,
            itemIds: [request.itemID],
        )
        let key = pendingHaul.flatMap { $0.body == body ? $0.key : nil } ?? UUID().uuidString.lowercased()
        pendingHaul = (key, body)
        let created = try await service.createHaul(body, idempotencyKey: key)
        pendingHaul = nil
        cost.haul = created
        replaceRecent(created)
    }

    /// Takes the item out of the haul it is in, if any.
    private func leaveHaul() async throws(APIFailure) {
        guard let haul = item?.haul else { return }
        _ = try await service.removeHaulItem(haulID: haul.id, itemID: request.itemID)
        item = try await service.item(id: request.itemID)
    }

    /// Reads the item back after a haul change: its cost is its share now.
    func readHaulCost() async throws(APIFailure) {
        let latest = try await service.item(id: request.itemID)
        item = latest
        if let haul = latest.haul {
            cost.haul = haul
            replaceRecent(haul)
        }
        if let cents = latest.details.cost?.amountCents {
            cost.amount = AmountEntry(cents: cents)
        }
    }

    /// The haul as the server now has it, first among the recent ones.
    private func replaceRecent(_ haul: Haul) {
        recentHauls.removeAll { $0.id == haul.id }
        recentHauls.insert(haul, at: 0)
    }

    /// "$1.67 each, from a $50 haul of 30" for the haul the screen shows: the chosen one, or the
    /// new one once its total and count are entered.
    var haulSummary: String? {
        if let haul = cost.haul {
            return HaulPresentation.summary(haul)
        }
        guard let total = cost.haulTotal.cents, let count = cost.haulCount.value else { return nil }
        return HaulPresentation.summary(
            eachCents: HaulPresentation.eachCents(totalCents: total, count: count),
            totalCents: total,
            count: count,
        )
    }
}
