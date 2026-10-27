import APIClient
import Core
import Foundation
import ListoraAPI

extension ReviewFlowModel {
    // MARK: Review

    func update(_ key: ReviewFieldKey, to value: FieldValue) {
        form?.set(key, to: value)
        if Self.prefillKeys.contains(key) {
            prefillDetailsChanged()
        }
    }

    /// Opens `key`'s in-place editor, keeping the text of the one open before.
    func beginEditing(_ key: ReviewFieldKey) {
        commitEditing()
        guard let form else { return }
        editing = FieldDraft(key: key, text: form.field(key).value.editingText)
    }

    /// Keeps the open editor's text in the form and closes the editor; with `key`, only when the
    /// open editor is that detail's.
    func commitEditing(_ key: ReviewFieldKey? = nil) {
        guard let draft = editing, key == nil || key == draft.key else { return }
        editing = nil
        update(draft.key, to: FieldValue.parse(draft.text, as: draft.key.kind))
    }

    /// Keeps the seller's copy for a marketplace; the analysis's own copy removes the edit.
    func saveCopy(_ copy: ListingCopy, for marketplace: String) {
        guard let index = copies.firstIndex(where: { $0.marketplace == marketplace }), let item else { return }
        let edited = copy == copies[index].suggested ? nil : copy
        do {
            try listingCopy.save(edited, marketplace: marketplace, itemID: item.id)
            copies[index].edited = edited
        } catch {
            log.error("Saving listing copy failed: \(String(describing: error), privacy: .public)")
            actionError = "Listora couldn't save this copy on your iPhone. Free up some storage and try again."
        }
    }

    var identifyHarder: IdentifyHarderEmphasis? {
        guard let form, analysis?.tier == .fast, escalation != .finished else { return nil }
        return form.identifyHarder(result: analysis?.result)
    }

    var premiumQuotaLine: String {
        QuotaPresentation.premiumLine(usage)
    }

    /// The plan's premium identifications are used up, so "Identify harder" can't run.
    var isPremiumQuotaUsedUp: Bool {
        QuotaPresentation.isUsedUp(usage)
    }

    /// "Identify harder": the premium identification of the fast analysis. The seller's edits are
    /// saved first, so the premium details never replace them.
    func startIdentifyHarder() async {
        guard let fastAnalysisID, escalation != .running, !isPremiumQuotaUsedUp else { return }
        commitEditing()
        escalation = .running
        do {
            try await saveEdits()
            let premium = try await service.escalate(
                analysisID: fastAnalysisID,
                idempotencyKey: UUID().uuidString.lowercased(),
            )
            await finishEscalation(premium)
        } catch {
            escalation = .failed(message: error.message, canRetry: error.retryable || error.statusCode == nil)
            usage = try? await service.usage()
        }
    }

    /// Follows a premium identification the server started on its own.
    func followEscalation(_ premiumID: String) {
        escalation = .running
        Task {
            do {
                try await finishEscalation(service.analysis(id: premiumID))
            } catch {
                escalation = .failed(message: APIFailure(error).message, canRetry: true)
            }
        }
    }

    private func finishEscalation(_ premium: Analysis) async {
        do {
            let finished = try await waitForAnalysis(premium, showsProgress: false)
            guard finished.status == .completed else {
                let failure = finished.failure
                escalation = .failed(
                    message: failure?.message ?? "The premium identification stopped without a reason.",
                    canRetry: failure?.retryable ?? true,
                )
                usage = try? await service.usage()
                return
            }
            // Edits made while it ran are saved too, before its details are applied.
            try await saveEdits()
            guard let item else { return }
            let applied = try await apply(finished, to: item)
            await enterReview(item: applied, analysis: finished, fastAnalysisID: fastAnalysisID)
            escalation = .finished
        } catch let failure as ReviewFlowError {
            escalation = .failed(message: failure.problem.message, canRetry: true)
        } catch {
            let failure = APIFailure(error)
            escalation = .failed(message: failure.message, canRetry: failure.retryable || failure.statusCode == nil)
        }
    }

    /// Saves the seller's edits of the details, keeping the review's order.
    func saveEdits() async throws(APIFailure) {
        guard let form, form.hasEdits else { return }
        let updated = try await replace { _, details in form.applyingEdits(to: details) }
        self.form = ReviewForm(item: updated, result: analysis?.result, attention: form.attention)
    }

    /// Continue from the review: saves the edits, then opens the cost screen.
    func continueToCost() async {
        commitEditing()
        await perform { () async throws(APIFailure) in
            try await saveEdits()
            showsCost = true
        }
    }

    // MARK: Cost

    /// Continue from the cost screen: saves the cost, date, and source (or clears the cost when
    /// skipped), then opens the price screen.
    func continueToPrice(skippingCost: Bool = false) async {
        let cents = skippingCost ? nil : cost.amount.cents
        let date = Self.day(cost.purchaseDate)
        let source = cost.source.trimmingCharacters(in: .whitespacesAndNewlines)
        await perform { () async throws(APIFailure) in
            _ = try await replace { _, details in
                var details = details
                details.cost = cents.map { Money(amountCents: $0, currency: .usd) }
                if !skippingCost {
                    details.purchaseDate = date
                    details.purchaseSource = source.isEmpty ? nil : source
                }
                return details
            }
            if !skippingCost, !source.isEmpty {
                recentSources.remember(source)
            }
            showsPrice = true
        }
        if showsPrice {
            await loadPricing()
        }
    }

    // MARK: Price

    func loadPricing() async {
        pricing = .loading
        do {
            let presentation = try await PricingPresentation(service.pricing(itemID: request.itemID))
            pricing = .loaded(presentation)
            if priceChoice == nil {
                if let listPrice = item?.details.listPrice?.amountCents {
                    priceChoice = presentation.tiers.first { $0.cents == listPrice }
                        .map { .tier($0.tier) } ?? .custom(listPrice)
                } else {
                    priceChoice = presentation.defaultTier.map { .tier($0.tier) }
                }
            }
        } catch {
            pricing = .failed(error.message)
        }
    }

    /// The price the seller chose, in cents.
    var chosenCents: Int64? {
        guard case let .loaded(presentation) = pricing, let priceChoice else { return nil }
        return switch priceChoice {
        case let .tier(name): presentation.tiers.first { $0.tier == name }?.cents
        case let .custom(cents): cents
        }
    }

    /// Saves the item as an inventory item ready to list: the chosen price, the highest floor, and
    /// status `ready`. Ends the interaction measurement and opens the saved screen.
    func save() async {
        guard let cents = chosenCents, cents > 0 else {
            actionError = "Choose a price first."
            return
        }
        var floorCents: Int64?
        if case let .loaded(presentation) = pricing {
            floorCents = presentation.highestFloor?.cents
        }
        await perform { () async throws(APIFailure) in
            let updated = try await replace(status: .ready) { _, details in
                var details = details
                details.listPrice = Money(amountCents: cents, currency: .usd)
                details.floorPrice = floorCents.map { Money(amountCents: $0, currency: .usd) }
                return details
            }
            let summary = meter.finish(request.sessionID, itemID: updated.id, sku: updated.sku)
            saved = SavedItem(
                sku: updated.sku,
                title: updated.details.title,
                price: updated.details.listPrice.map(Formatting.money),
                summary: summary,
            )
            showsSaved = true
        }
    }

    // MARK: Requests

    /// Runs a step's requests as waiting time, showing progress and any failure.
    func perform(_ step: () async throws(APIFailure) -> Void) async {
        guard !isWorking else { return }
        isWorking = true
        meter.setWaiting(true, for: request.sessionID)
        defer {
            isWorking = false
            meter.setWaiting(false, for: request.sessionID)
        }
        do {
            try await step()
        } catch {
            log.error("Review step failed: \(error.code, privacy: .public) \(error.message, privacy: .public)")
            actionError = error.message
        }
    }

    /// Replaces the item's details with `change(item, details)` applied to the latest ones. A
    /// version conflict reads the item again and applies the change once more on top of it.
    @discardableResult
    func replace(
        status: Components.Schemas.UserSettableItemStatus? = nil,
        _ change: (Item, ItemDetails) -> ItemDetails,
    ) async throws(APIFailure) -> Item {
        var current: Item = if let item {
            item
        } else {
            try await service.item(id: request.itemID)
        }
        do {
            let updated = try await service.replace(
                itemID: current.id,
                with: ItemReplace(
                    expectedVersion: current.version,
                    status: status,
                    details: change(current, current.details),
                ),
            )
            item = updated
            return updated
        } catch where error.knownCode == .versionConflict {
            current = try await service.item(id: request.itemID)
            let updated = try await service.replace(
                itemID: current.id,
                with: ItemReplace(
                    expectedVersion: current.version,
                    status: status,
                    details: change(current, current.details),
                ),
            )
            item = updated
            return updated
        }
    }
}
