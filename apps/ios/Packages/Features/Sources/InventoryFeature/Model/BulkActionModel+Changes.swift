import APIClient
import Core
import Foundation
import ListoraAPI

/// Each change of a ``BulkAction`` on one item, through the same calls as the item screen.
extension BulkActionModel {
    /// The item's draft on the marketplace, created or brought up to date, then published. A
    /// draft whose earlier listing failed is sent again by that try's Retry instead.
    func list(_ item: Item, on marketplace: KnownMarketplace) async -> BulkOutcome {
        let id = marketplace.rawValue
        let name = Formatting.marketplaceName(id)
        let connection = connections.first { $0.marketplace.value1 == marketplace }
        let existing = item.listings.first { $0.marketplace.value1 == marketplace }
        if let existing, existing.isWorking {
            return outcome(
                item, id, .skipped,
                "Still working on the last change on \(name). Try again once it's done.",
            )
        }
        if let existing, let failed = existing.failedListing {
            return await retryListing(item, on: id, failed)
        }
        let variant: ListingVariant
        switch await listingVariant(of: item, on: marketplace, existing: existing, connection: connection) {
        case let .success(made): variant = made
        case let .failure(skip): return outcome(item, id, .skipped, skip.reason)
        }
        do {
            let listingID: String
            if let existing {
                _ = try await send { [service] _ throws(APIFailure) in
                    try await service.replaceDraft(listingID: existing.id, variant: variant)
                }
                listingID = existing.id
            } else {
                listingID = try await send { [service] key throws(APIFailure) in
                    try await service.createListing(
                        itemID: item.id, marketplace: marketplace, variant: variant, idempotencyKey: key,
                    ).id
                }
            }
            _ = try await send { [service] key throws(APIFailure) in
                try await service.perform(.publish(listingID: listingID), idempotencyKey: key)
            }
        } catch {
            return outcome(item, id, .failed, error.message)
        }
        let assisted = MarketplaceRowState.isAssisted(marketplace: marketplace, connection: connection)
        return outcome(
            item, id, .started,
            assisted
                ? "Task added: post it in the \(name) app."
                : "Listing on \(name) started. It shows as listed once \(name) confirms.",
        )
    }

    /// The failed listing's Retry, as the item screen's: it may have reached the marketplace, so
    /// the server takes no new draft for it and sends the same listing again
    /// (`docs/features/operations.md`).
    private func retryListing(_ item: Item, on id: String, _ failed: Operation) async -> BulkOutcome {
        let name = Formatting.marketplaceName(id)
        guard failed.error?.retryable ?? true else {
            return outcome(item, id, .skipped, "Listing on \(name) failed. Open the item to see why.")
        }
        do {
            _ = try await send { [service] key throws(APIFailure) in
                try await service.retry(operationID: failed.id, idempotencyKey: key)
            }
        } catch {
            return outcome(item, id, .failed, error.message)
        }
        return outcome(
            item, id, .started,
            "Listing on \(name) started again. It shows as listed once \(name) confirms.",
        )
    }

    /// Why Listora lists nothing on a marketplace, in words that say what to do.
    struct Skip: Error {
        let reason: String
    }

    /// The listing Listora would send, or why it can't send one without the seller: what the List
    /// flow's review would refuse is skipped here rather than guessed.
    private func listingVariant(
        of item: Item,
        on marketplace: KnownMarketplace,
        existing: Listing?,
        connection: Connection?,
    ) async -> Result<ListingVariant, Skip> {
        let id = marketplace.rawValue
        let name = Formatting.marketplaceName(id)
        if let existing, existing.status.value1 != .draft {
            return .failure(Skip(reason: "Already on \(name)."))
        }
        guard MarketplaceRowState.canList(marketplace: marketplace, connection: connection) else {
            return .failure(Skip(reason: "Connect \(name) in Settings > Marketplaces first."))
        }
        let copy = await SuggestedCopy.load(for: id, item: item, service: service, listingCopy: listingCopy)
        let title = copy.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return .failure(Skip(reason: "Add a title to the item first.")) }
        guard let cents = copy.priceCents, cents > 0 else {
            return .failure(Skip(reason: "Add a price to the item first."))
        }
        if marketplace == .ebay, title.utf16.count > ListingFlowModel.ebayTitleLimit {
            return .failure(Skip(
                reason: "The title is longer than eBay's \(ListingFlowModel.ebayTitleLimit) characters. "
                    + "List it from the item to shorten it.",
            ))
        }
        var categoryRef: String?
        if ListingFlowModel.categorized.contains(id) {
            let categories = try? await service.marketplaceCategories(itemID: item.id, marketplace: id)
            guard let suggested = categories?.suggested else {
                return .failure(Skip(reason: "Choose its \(name) category: list it from the item."))
            }
            categoryRef = suggested.ref
        }
        return .success(ListingVariant(
            title: title,
            description: copy.description,
            price: Money(amountCents: Int64(cents), currency: .usd),
            categoryRef: categoryRef,
            condition: item.details.condition,
        ))
    }

    /// The same request on each listing that allows `action` now.
    func perform(
        on item: Item,
        allowing action: Components.Schemas.KnownListingAction,
        nothing: String,
        _ request: (Listing) -> ListingRequest,
    ) async -> [BulkOutcome] {
        let listings = item.listings.filter { $0.allows(action) }
        let busy = busyOutcomes(of: item)
        guard !listings.isEmpty else { return busy.isEmpty ? [outcome(item, nil, .skipped, nothing)] : busy }
        var results = busy
        for listing in listings {
            let name = Formatting.marketplaceName(listing.marketplace.id)
            let sent = request(listing)
            do {
                _ = try await send { [service] key throws(APIFailure) in
                    try await service.perform(sent, idempotencyKey: key)
                }
                let started = switch sent {
                case .end: "Ending on \(name) started."
                case .relist: "Relisting on \(name) started."
                default: "Started on \(name)."
                }
                results.append(outcome(item, listing.marketplace.id, .started, started))
            } catch {
                results.append(outcome(item, listing.marketplace.id, .failed, error.message))
            }
        }
        return results
    }

    /// Each live listing's price, then the item's list price, by the same rule; never below the
    /// item's floor on a marketplace, which the seller can still choose on the item screen.
    func changePrice(of item: Item, by adjustment: PriceAdjustment) async -> [BulkOutcome] {
        var results = busyOutcomes(of: item)
        let live = item.listings.filter { $0.allows(.changePrice) }
        let floors = live.isEmpty ? [] : await (try? service.floors(itemID: item.id)) ?? []
        for listing in live {
            let id = listing.marketplace.id
            let name = Formatting.marketplaceName(id)
            guard let current = listing.variant?.price ?? item.details.listPrice,
                  let new = adjustment.apply(to: current.amountCents)
            else {
                results.append(outcome(item, id, .skipped, "No price above $0 comes out of that."))
                continue
            }
            let price = Money(amountCents: new, currency: current.currency)
            let floor = floors.first { $0.marketplace.value1?.rawValue == id || $0.marketplace.value2 == id }?
                .floorPrice
            if let floor, new < floor.amountCents {
                results.append(outcome(
                    item, id, .skipped,
                    "\(Formatting.money(price)) is below your \(Formatting.money(floor)) floor on \(name). "
                        + "Change it from the item if you're sure.",
                ))
                continue
            }
            do {
                _ = try await send { [service] key throws(APIFailure) in
                    try await service.perform(.changePrice(listingID: listing.id, price: price), idempotencyKey: key)
                }
                results.append(outcome(
                    item, id, .started,
                    "Changing to \(Formatting.money(price)) on \(name). It shows once \(name) confirms.",
                ))
            } catch {
                results.append(outcome(item, id, .failed, error.message))
            }
        }
        await results.append(changeListPrice(of: item, by: adjustment))
        return results
    }

    /// The item's own list price, which new listings start from.
    func changeListPrice(of item: Item, by adjustment: PriceAdjustment) async -> BulkOutcome {
        guard let price = item.details.listPrice, let new = adjustment.apply(to: price.amountCents) else {
            return outcome(item, nil, .skipped, "The item has no list price to change.")
        }
        var current = item
        for attempt in 1 ... 2 {
            var details = current.details
            details.listPrice = Money(amountCents: new, currency: price.currency)
            do {
                _ = try await service.replaceItem(
                    id: item.id,
                    with: .init(expectedVersion: current.version, details: details),
                )
                return outcome(item, nil, .done, "List price is now \(Formatting.money(cents: new)).")
            } catch {
                // Changed elsewhere meanwhile: once more on the newest version.
                guard error.statusCode == 409, attempt == 1,
                      let latest = try? await service.item(id: item.id)
                else {
                    return outcome(item, nil, .failed, error.message)
                }
                current = latest
            }
        }
        return outcome(item, nil, .failed, "The list price didn't change.")
    }

    func delete(_ item: Item) async -> BulkOutcome {
        do {
            try await send { [service] _ throws(APIFailure) in try await service.deleteItem(id: item.id) }
            return outcome(item, nil, .done, "Deleted.")
        } catch {
            // Already gone (deleted on another device) is what was asked.
            if error.statusCode == 404 {
                return outcome(item, nil, .done, "Deleted.")
            }
            return outcome(item, nil, .failed, error.message)
        }
    }

    /// A listing whose last change is still running takes no other until it is done (one change
    /// at a time), which the seller is told rather than left guessing.
    private func busyOutcomes(of item: Item) -> [BulkOutcome] {
        item.listings.filter(\.isWorking).map { listing in
            let name = Formatting.marketplaceName(listing.marketplace.id)
            return outcome(
                item, listing.marketplace.id, .skipped,
                "Still working on the last change on \(name). Try again once it's done.",
            )
        }
    }

    /// One call with its own Idempotency-Key, sent again with that key while the answer is lost.
    func send<T: Sendable>(
        _ call: @escaping @Sendable (String) async throws(APIFailure) -> T,
    ) async throws(APIFailure) -> T {
        let key = UUID().uuidString
        var attempt = 0
        while true {
            do {
                return try await call(key)
            } catch {
                attempt += 1
                guard ItemDetailModel.mayResend(error), attempt < timing.sendAttempts else { throw error }
                try? await Task.sleep(for: timing.sendRetryDelay)
            }
        }
    }

    func outcome(
        _ item: Item,
        _ marketplace: String?,
        _ result: BulkOutcome.Result,
        _ message: String,
    ) -> BulkOutcome {
        BulkOutcome(
            itemID: item.id,
            sku: item.sku,
            title: item.details.title ?? "Untitled item",
            marketplace: marketplace,
            result: result,
            message: message,
        )
    }

    func outcome(
        _ item: ItemSummary,
        _ marketplace: String?,
        _ result: BulkOutcome.Result,
        _ message: String,
    ) -> BulkOutcome {
        BulkOutcome(
            itemID: item.id,
            sku: item.sku,
            title: item.title ?? "Untitled item",
            marketplace: marketplace,
            result: result,
            message: message,
        )
    }
}

extension Listing {
    /// The server allows `action` on the listing now.
    func allows(_ action: Components.Schemas.KnownListingAction) -> Bool {
        availableActions.contains { $0.action.value1 == action && $0.mode.value1 != nil }
    }

    /// The failed create of a draft the server won't publish anew: it is sent again by its Retry.
    var failedListing: Operation? {
        guard status.value1 == .draft, !allows(.publish), let operation = latestOperation,
              operation.status.value1 == .failed, operation.kind.value1 == .create
        else { return nil }
        return operation
    }

    /// Its newest change is still running or waiting.
    var isWorking: Bool {
        switch latestOperation?.status.value1 {
        case .queued, .running, .retrying, .verifying: true
        default: false
        }
    }
}
