import Foundation

/// The common values a detail offers when the seller touches and holds it, each as the
/// changes choosing it makes. Lists (colors, materials) toggle a value; flaws add one.
enum QuickValues {
    struct Option: Equatable, Identifiable, Sendable {
        let title: String
        let changes: [VoiceChange]
        /// The detail has this value now (shown with a check).
        let isCurrent: Bool

        var id: String {
            title
        }
    }

    static let sizes = ["XS", "S", "M", "L", "XL", "XXL"]
    static let colors = ["black", "white", "gray", "navy", "blue", "red", "green", "brown", "beige", "pink"]
    static let materials = ["cotton", "polyester", "wool", "denim", "leather", "silk", "linen", "cashmere"]
    static let patterns = ["solid", "striped", "plaid", "floral", "graphic"]
    static let flaws = ["Small stain", "Small hole", "Pilling", "Fading", "Missing button", "Snag"]

    /// The options for `field`; empty when it has none (free text, or a detail whose tap already
    /// opens its choices).
    static func options(for field: ReviewField) -> [Option] {
        let value = field.value
        switch field.key {
        case .sizeLabel:
            let current = value.editingText
            return sizes.map { size in
                Option(
                    title: size,
                    changes: [.set(.sizeLabel, .text(size)), .set(.sizeSystem, .text("letter"))],
                    isCurrent: current == size,
                )
            } + [Option(
                title: "One size",
                changes: [.set(.sizeLabel, .text("One size")), .set(.sizeSystem, .text("one_size"))],
                isCurrent: current == "One size",
            )]
        case .colors:
            return toggles(.colors, values: colors, current: value)
        case .materials:
            return toggles(.materials, values: materials, current: value)
        case .pattern:
            return patterns.map { pattern in
                Option(
                    title: ItemVocabulary.humanize(pattern),
                    changes: [.set(.pattern, .text(pattern))],
                    isCurrent: value == .text(pattern),
                )
            }
        case .flaws:
            let entries = if case let .list(values) = value {
                values
            } else {
                [String]()
            }
            return [Option(title: "No flaws", changes: [.set(.flaws, .list([]))], isCurrent: entries.isEmpty)]
                + flaws.map { flaw in
                    Option(
                        title: flaw,
                        changes: [.add(.flaws, flaw)],
                        isCurrent: entries.contains { $0.caseInsensitiveCompare(flaw) == .orderedSame },
                    )
                }
        default:
            return []
        }
    }

    /// Each value on or off in the list, keeping the order of the values already there.
    private static func toggles(_ key: ReviewFieldKey, values: [String], current: FieldValue) -> [Option] {
        let selected = if case let .list(list) = current {
            list
        } else {
            [String]()
        }
        return values.map { value in
            let isOn = selected.contains(value)
            let toggled = isOn ? selected.filter { $0 != value } : selected + [value]
            return Option(
                title: ItemVocabulary.humanize(value),
                changes: [.set(key, .list(toggled))],
                isCurrent: isOn,
            )
        }
    }
}
