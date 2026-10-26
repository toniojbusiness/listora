import Foundation
import ListoraAPI

typealias VoiceCorrection = Components.Schemas.VoiceCorrection

/// One change a spoken (or typed) correction proposes, before the seller accepts it.
enum VoiceChange: Equatable, Hashable, Sendable {
    /// Replaces a detail's value.
    case set(ReviewFieldKey, FieldValue)
    /// Adds one entry to a list detail (keywords, flaws).
    case add(ReviewFieldKey, String)
    /// What the seller paid, in cents.
    case cost(Int64)
    /// Where the seller bought it.
    case purchaseSource(String)
    /// The price to list it at, in cents.
    case listPrice(Int64)

    /// What the change is to; two changes to one target cannot both apply.
    enum Target: Hashable, Sendable {
        case detail(ReviewFieldKey)
        case cost
        case purchaseSource
        case listPrice
    }

    var target: Target {
        switch self {
        case let .set(key, _), let .add(key, _): .detail(key)
        case .cost: .cost
        case .purchaseSource: .purchaseSource
        case .listPrice: .listPrice
        }
    }

    /// "Size", "Paid", "Bought at", "Price".
    var title: String {
        switch self {
        case let .set(key, _), let .add(key, _): key.title
        case .cost: "Paid"
        case .purchaseSource: "Bought at"
        case .listPrice: "Price"
        }
    }

    /// The new value as the chip shows it: "M", "+ Small stain on the left cuff", "$4.00".
    var valueText: String {
        switch self {
        case let .set(key, value): value.isEmpty ? "None" : key.display(value)
        case let .add(_, entry): "+ \(entry)"
        case let .cost(cents), let .listPrice(cents): Formatting.money(cents: cents)
        case let .purchaseSource(source): source
        }
    }

    /// "Size: M", read as one phrase.
    var summary: String {
        "\(title): \(valueText)"
    }
}

extension VoiceChange {
    /// The server's interpretation as changes this app can apply. A field this app does not
    /// know, or a change without the value its field needs, is left out. The colors and
    /// materials of one answer together replace the detail's values; keywords and flaws are added.
    static func changes(from correction: VoiceCorrection) -> [VoiceChange] {
        var changes: [VoiceChange] = []
        for change in correction.changes {
            guard let field = change.field.value1, let next = Self.change(field, change) else { continue }
            // Each color or material joins the first change to that detail.
            if case let .set(key, .list(more)) = next,
               let index = changes.firstIndex(where: { $0.target == next.target }),
               case let .set(_, .list(values)) = changes[index]
            {
                changes[index] = .set(key, .list(values + more))
            } else {
                changes.append(next)
            }
        }
        return changes
    }

    private static func change(
        _ field: Components.Schemas.KnownVoiceCorrectionField,
        _ change: Components.Schemas.VoiceCorrectionChange,
    ) -> VoiceChange? {
        switch field {
        case .cost, .listPrice:
            guard let cents = change.amount?.amountCents, cents >= 0 else { return nil }
            return field == .cost ? .cost(cents) : .listPrice(cents)
        case .purchaseSource:
            return change.value.map { .purchaseSource($0) }
        default:
            guard let key = ReviewFieldKey(rawValue: field.rawValue), let value = change.value else { return nil }
            return switch key {
            case .colors, .materials: .set(key, .list([value]))
            case .keywords, .flaws: .add(key, value)
            default: .set(key, .text(value))
            }
        }
    }
}
