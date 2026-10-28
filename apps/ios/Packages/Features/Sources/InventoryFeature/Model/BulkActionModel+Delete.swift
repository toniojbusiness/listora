import APIClient
import Core
import Foundation
import ListoraAPI

/// Delete (``DeleteMode``): an item on no marketplace is deleted; for a live one the seller chose to
/// end its listings first or leave them up (docs/features/inventory.md).
extension BulkActionModel {
    func delete(_ item: Item, _ mode: DeleteMode) async -> [BulkOutcome] {
        switch mode {
        case .notListed: await [deleteNow(item, leavingListings: false)]
        case .leaveListings: await [deleteNow(item, leavingListings: true)]
        case .endListingsFirst: await endThenDelete(item)
        }
    }

    private func deleteNow(_ item: Item, leavingListings: Bool) async -> BulkOutcome {
        do {
            try await send { [service] _ throws(APIFailure) in
                try await service.deleteItem(id: item.id, leavingListings: leavingListings)
            }
        } catch {
            // Already gone (deleted on another device) is what was asked.
            guard error.statusCode == 404 else { return outcome(item, nil, .failed, error.message) }
        }
        let leftUp = leavingListings && item.listings.contains(where: \.status.mayBeLive)
        return outcome(item, nil, .done, leftUp ? "Removed from Listora. Its listings stay up." : "Deleted.")
    }

    /// Ends each live listing, waits for its marketplace to confirm, then deletes the item. An item
    /// still live once the wait is over stays in Listora, with each listing's state and what to do.
    private func endThenDelete(_ item: Item) async -> [BulkOutcome] {
        let live = item.listings.filter(\.status.mayBeLive)
        guard !live.isEmpty else { return await [deleteNow(item, leavingListings: false)] }
        var refused: [String: BulkOutcome] = [:]
        for listing in live where listing.allows(.end) && !listing.isWorking {
            do {
                _ = try await send { [service] key throws(APIFailure) in
                    try await service.perform(
                        .end(listingID: listing.id, reason: EndReason.notAvailable.contract),
                        idempotencyKey: key,
                    )
                }
            } catch {
                refused[listing.id] = outcome(item, listing.marketplace.id, .failed, error.message)
            }
        }
        let settled = await waitForEnds(of: item)
        var results = live.compactMap { listing -> BulkOutcome? in
            let now = settled.listings.first { $0.id == listing.id }
            let name = Formatting.marketplaceName(listing.marketplace.id)
            guard let now, now.status.mayBeLive else {
                return outcome(item, listing.marketplace.id, .done, "Ended on \(name).")
            }
            if let failed = refused[listing.id] {
                return failed
            }
            if now.isWorking {
                return outcome(
                    item, listing.marketplace.id, .started,
                    "Ending on \(name). Delete the item again once it has ended.",
                )
            }
            return outcome(
                item, listing.marketplace.id, .failed,
                "Still listed on \(name) (\(now.statusDisplay.label)). End it from the item, or remove the "
                    + "item from Listora only.",
            )
        }
        if settled.listings.contains(where: \.status.mayBeLive) {
            results.append(outcome(item, nil, .skipped, "Kept in Listora while it's still listed."))
        } else {
            await results.append(deleteNow(settled, leavingListings: false))
        }
        return results
    }

    /// The item read again until none of its listings is still changing, or ``DetailTiming/endWait``
    /// is over; each read waits longer, up to ``DetailTiming/longestPoll``.
    private func waitForEnds(of item: Item) async -> Item {
        let deadline = ContinuousClock.now + timing.endWait
        var latest = item
        var delay = timing.poll
        repeat {
            try? await Task.sleep(for: delay)
            if let fresh = try? await service.item(id: item.id) {
                latest = fresh
            }
            delay = min(delay * 2, timing.longestPoll)
        } while latest.listings.contains(where: \.isWorking) && ContinuousClock.now < deadline
        return latest
    }
}

extension Components.Schemas.ListingStatus {
    /// The listing may be up on its marketplace: anything but never posted (`draft`) or already off
    /// it (`ended`, `sold`), as the server's `deleteItem` decides. A status this app doesn't know may be.
    var mayBeLive: Bool {
        switch value1 {
        case .draft, .ended, .sold: false
        default: true
        }
    }
}
