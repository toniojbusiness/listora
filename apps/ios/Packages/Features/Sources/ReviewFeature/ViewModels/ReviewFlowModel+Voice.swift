import APIClient
import Foundation

/// How to take back one accepted change.
enum VoiceUndo: Equatable, Sendable {
    /// Puts the detail's value from before back.
    case detail(ReviewFieldKey, FieldValue)
    /// Takes out the entry the change added (other entries added since stay).
    case removeEntry(ReviewFieldKey, String)
    case cost(AmountEntry)
    case purchaseSource(String)
    case listPrice(ReviewFlowModel.PriceChoice?)
}

/// What a spoken correction changes: the review's details, the cost draft, and the price
/// choice. The review is one; batch review can be another.
@MainActor
protocol VoiceCorrectionTarget: AnyObject {
    var voiceContext: VoiceParseContext { get }
    /// The change would leave everything as it is.
    func isAlreadySet(_ change: VoiceChange) -> Bool
    /// Applies the change as the seller's own edit, and answers how to take it back.
    func apply(_ change: VoiceChange) -> VoiceUndo
    func undo(_ undo: VoiceUndo)
    /// The server's text model's reading of phrases the on-device parser could not map.
    func interpretVoice(_ text: String, idempotencyKey: String) async throws(APIFailure) -> [VoiceChange]
}

extension ReviewFlowModel: VoiceCorrectionTarget {
    var voiceContext: VoiceParseContext {
        let category = form?.field(.category).value.editingText
        return VoiceParseContext(
            category: category?.isEmpty == false ? category : nil,
            recentSources: recentSources.sources,
        )
    }

    func isAlreadySet(_ change: VoiceChange) -> Bool {
        switch change {
        case let .set(key, value):
            return form?.field(key).value == value
        case let .add(key, entry):
            guard case let .list(values) = form?.field(key).value else { return false }
            return values.contains { $0.caseInsensitiveCompare(entry) == .orderedSame }
        case let .cost(cents):
            return cost.amount.cents == cents
        case let .purchaseSource(source):
            return cost.source.caseInsensitiveCompare(source) == .orderedSame
        case let .listPrice(cents):
            return priceChoice == .custom(cents)
        }
    }

    func apply(_ change: VoiceChange) -> VoiceUndo {
        // An open editor's text is kept first, so it cannot overwrite the change later.
        commitEditing()
        switch change {
        case let .set(key, value):
            let before = form?.field(key).value ?? value
            update(key, to: value)
            return .detail(key, before)
        case let .add(key, entry):
            let values = if case let .list(values) = form?.field(key).value {
                values
            } else {
                [String]()
            }
            update(key, to: .list(values + [entry]))
            return .removeEntry(key, entry)
        case let .cost(cents):
            let before = cost.amount
            cost.amount = AmountEntry(cents: cents)
            return .cost(before)
        case let .purchaseSource(source):
            let before = cost.source
            cost.source = source
            return .purchaseSource(before)
        case let .listPrice(cents):
            let before = priceChoice
            priceChoice = .custom(cents)
            return .listPrice(before)
        }
    }

    func undo(_ undo: VoiceUndo) {
        commitEditing()
        switch undo {
        case let .detail(key, value):
            update(key, to: value)
        case let .removeEntry(key, entry):
            if case let .list(values) = form?.field(key).value, let index = values.firstIndex(of: entry) {
                var remaining = values
                remaining.remove(at: index)
                update(key, to: .list(remaining))
            }
        case let .cost(amount):
            cost.amount = amount
        case let .purchaseSource(source):
            cost.source = source
        case let .listPrice(choice):
            priceChoice = choice
        }
    }

    func interpretVoice(_ text: String, idempotencyKey: String) async throws(APIFailure) -> [VoiceChange] {
        meter.setWaiting(true, for: request.sessionID)
        defer { meter.setWaiting(false, for: request.sessionID) }
        let correction = try await service.interpretVoiceCorrection(
            itemID: request.itemID,
            transcript: text,
            idempotencyKey: idempotencyKey,
        )
        return VoiceChange.changes(from: correction)
    }

    /// Applies a common value the seller picked by touching and holding a detail.
    func choose(_ option: QuickValues.Option) {
        for change in option.changes {
            _ = apply(change)
        }
    }

    // MARK: Next to check

    /// The details that still need a look, in the review's order.
    var fieldsToCheck: [ReviewFieldKey] {
        guard let form else { return [] }
        return form.attention.filter { form.field($0).needsAttention }
    }

    /// Moves to the next detail that still needs a look after `key` (from the top without one),
    /// wrapping around, and opens its editor when it is typed in place. The view scrolls to
    /// ``focusedField``.
    func advanceToNextCheck(after key: ReviewFieldKey? = nil) {
        let current = key ?? editing?.key ?? focusedField
        commitEditing()
        let keys = fieldsToCheck
        guard !keys.isEmpty else {
            focusedField = nil
            return
        }
        let next: ReviewFieldKey = if let current, let index = keys.firstIndex(of: current) {
            keys[(index + 1) % keys.count]
        } else if let current, let position = form?.attention.firstIndex(of: current) {
            // The current detail no longer needs a look: the first one after it.
            keys.first { (form?.attention.firstIndex(of: $0) ?? 0) > position } ?? keys[0]
        } else {
            keys[0]
        }
        focusedField = next
        if next.kind != .choice {
            beginEditing(next)
        }
    }
}
