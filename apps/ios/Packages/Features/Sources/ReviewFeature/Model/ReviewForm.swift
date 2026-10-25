import Foundation
import ListoraAPI

/// The confidence-first review of an analyzed item: every detail with its value, where the
/// value came from, and the analysis's confidence, plus the seller's edits.
///
/// Details the seller should check (proposed below ``lowConfidence``, or empty but needed to list
/// the item) come first, in ``attention``, lowest confidence first after the missing ones. That
/// order is fixed when the form is built from an analysis, so rows never jump while the seller
/// edits them; an edited row stays in place and loses its highlight.
struct ReviewForm: Equatable, Sendable {
    /// Below this the analysis asks a person to check the value (the analysis prompt's own rule,
    /// `output-schema.ts`, and the confidence the server caps a contradicted tag fact at).
    static let lowConfidence = 0.6

    /// The item's details with the seller's edits.
    private(set) var details: ItemDetails
    let analyzed: [ReviewFieldKey: AnalyzedValue]
    /// The server's `fieldProvenance` when the form was built.
    let serverProvenance: [ReviewFieldKey: ReviewProvenance]
    private(set) var edited: Set<ReviewFieldKey> = []
    private(set) var attention: [ReviewFieldKey] = []

    /// The form for `item` as `result` proposed it. `attention` keeps an earlier form's order
    /// (after saving edits); nil orders the details that need attention now.
    init(item: Item, result: AnalysisResult?, attention: [ReviewFieldKey]? = nil) {
        details = item.details
        var analyzed: [ReviewFieldKey: AnalyzedValue] = [:]
        if let proposed = result?.details {
            for key in ReviewFieldKey.allCases {
                analyzed[key] = proposed.analyzed(key)
            }
        }
        self.analyzed = analyzed
        var provenance: [ReviewFieldKey: ReviewProvenance] = [:]
        for (name, source) in item.fieldProvenance?.additionalProperties ?? [:] {
            if let key = ReviewFieldKey(rawValue: name) {
                provenance[key] = ReviewProvenance(source.value1?.rawValue ?? source.value2 ?? "")
            }
        }
        serverProvenance = provenance
        self.attention = attention ?? Self.order(ReviewFieldKey.allCases.map(field).filter(\.needsAttention))
    }

    /// Missing details first, then the lowest confidence; ties keep the canonical order.
    private static func order(_ fields: [ReviewField]) -> [ReviewFieldKey] {
        fields.enumerated().sorted { lhs, rhs in
            let left = lhs.element.isMissing ? -1 : lhs.element.confidence ?? 1
            let right = rhs.element.isMissing ? -1 : rhs.element.confidence ?? 1
            return left == right ? lhs.offset < rhs.offset : left < right
        }.map(\.element.key)
    }

    func field(_ key: ReviewFieldKey) -> ReviewField {
        let value = details.value(key)
        let proposal = analyzed[key]
        let matchesProposal = proposal.map { $0.value == value } ?? false
        let provenance: ReviewProvenance? = if edited.contains(key) {
            matchesProposal ? proposal?.provenance : (value.isEmpty ? nil : .user)
        } else {
            serverProvenance[key] ?? (matchesProposal ? proposal?.provenance : nil)
        }
        let confidence = matchesProposal ? proposal?.confidence : nil
        return ReviewField(
            key: key,
            value: value,
            provenance: provenance,
            confidence: confidence,
            isLowConfidence: provenance != .user && (confidence.map { $0 < Self.lowConfidence } ?? false),
            isMissing: key.isRequiredToList && value.isEmpty,
        )
    }

    /// The sections in display order, each with its details: those needing attention only in
    /// the first.
    var sections: [(section: ReviewSection, keys: [ReviewFieldKey])] {
        var sections: [(ReviewSection, [ReviewFieldKey])] = []
        if !attention.isEmpty {
            sections.append((.attention, attention))
        }
        for section in [ReviewSection.details, .condition, .copy] {
            let keys = ReviewFieldKey.allCases.filter { $0.section == section && !attention.contains($0) }
            if !keys.isEmpty {
                sections.append((section, keys))
            }
        }
        return sections
    }

    var hasEdits: Bool {
        !edited.isEmpty
    }

    /// Details still needed to list the item.
    var missing: [ReviewFieldKey] {
        ReviewFieldKey.allCases.filter { field($0).isMissing }
    }

    mutating func set(_ key: ReviewFieldKey, to value: FieldValue) {
        guard details.value(key) != value else { return }
        details.set(key, to: value)
        edited.insert(key)
    }

    /// The details with the seller's edits applied over `base` (the server's latest), for a
    /// replace after a version conflict.
    func applyingEdits(to base: ItemDetails) -> ItemDetails {
        var merged = base
        for key in edited {
            merged.set(key, to: details.value(key))
        }
        return merged
    }

    /// How strongly to offer "Identify harder" for this form.
    func identifyHarder(result: AnalysisResult?) -> IdentifyHarderEmphasis {
        let brand = field(.brand)
        if brand.provenance == .user {
            return result?.needsEscalation == true ? .prominent(reason: escalationReason(result)) : .available
        }
        if brand.value.isEmpty {
            return .prominent(reason: "Listora couldn't find the brand.")
        }
        if brand.isLowConfidence {
            return .prominent(reason: "The brand is a guess.")
        }
        if result?.needsEscalation == true {
            return .prominent(reason: escalationReason(result))
        }
        return .available
    }

    private func escalationReason(_ result: AnalysisResult?) -> String {
        let reason = result?.escalationReason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return reason.isEmpty ? "This item may need a closer look." : reason
    }
}

enum IdentifyHarderEmphasis: Equatable, Sendable {
    /// A prominent card: the brand is missing or uncertain, or the analysis asked for it.
    case prominent(reason: String)
    /// A quiet button.
    case available
}

/// How a detail is read from and written to the contract's types: the details as text, as a
/// list, or as the condition (the one closed enum).
private enum DetailAccess: Sendable {
    typealias Details = Components.Schemas.ItemDetails
    typealias Analyzed = Components.Schemas.AnalyzedDetails

    case text(
        WritableKeyPath<Details, String?> & Sendable,
        KeyPath<Analyzed, Components.Schemas.AnalyzedText?> & Sendable,
    )
    case list(
        WritableKeyPath<Details, [String]?> & Sendable,
        KeyPath<Analyzed, Components.Schemas.AnalyzedTextList?> & Sendable,
    )
    case condition

    static let byKey: [ReviewFieldKey: DetailAccess] = [
        .title: .text(\.title, \.title),
        .description: .text(\.description, \.description),
        .brand: .text(\.brand, \.brand),
        .productName: .text(\.productName, \.productName),
        .category: .text(\.category, \.category),
        .department: .text(\.department, \.department),
        .sizeLabel: .text(\.sizeLabel, \.sizeLabel),
        .sizeSystem: .text(\.sizeSystem, \.sizeSystem),
        .colors: .list(\.colors, \.colors),
        .pattern: .text(\.pattern, \.pattern),
        .materials: .list(\.materials, \.materials),
        .keywords: .list(\.keywords, \.keywords),
        .styleNumber: .text(\.styleNumber, \.styleNumber),
        .rnNumber: .text(\.rnNumber, \.rnNumber),
        .upc: .text(\.upc, \.upc),
        .condition: .condition,
        .conditionNotes: .text(\.conditionNotes, \.conditionNotes),
        .flaws: .list(\.flaws, \.flaws),
    ]

    static func of(_ key: ReviewFieldKey) -> DetailAccess {
        // Every key is in the table (ReviewFormTests reads and writes each one).
        byKey[key] ?? .condition
    }
}

extension ItemDetails {
    func value(_ key: ReviewFieldKey) -> FieldValue {
        switch DetailAccess.of(key) {
        case let .text(path, _): .text(self[keyPath: path] ?? "")
        case let .list(path, _): .list(self[keyPath: path] ?? [])
        case .condition: .text(condition?.rawValue ?? "")
        }
    }

    /// Sets a detail; an empty value removes it (absent means no value).
    mutating func set(_ key: ReviewFieldKey, to value: FieldValue) {
        switch (DetailAccess.of(key), value) {
        case let (.text(path, _), .text(text)): self[keyPath: path] = text.isEmpty ? nil : text
        case let (.list(path, _), .list(values)): self[keyPath: path] = values.isEmpty ? nil : values
        case let (.condition, .text(text)): condition = Components.Schemas.ItemCondition(rawValue: text)
        // A value of the other shape is a programming error; it clears the detail.
        case let (.text(path, _), .list): self[keyPath: path] = nil
        case let (.list(path, _), .text): self[keyPath: path] = nil
        case (.condition, .list): condition = nil
        }
    }
}

extension Components.Schemas.AnalyzedDetails {
    func analyzed(_ key: ReviewFieldKey) -> AnalyzedValue? {
        switch DetailAccess.of(key) {
        case let .text(_, path):
            self[keyPath: path].map {
                AnalyzedValue(
                    value: .text($0.value),
                    confidence: $0.confidence,
                    provenance: Self.provenance($0.provenance),
                )
            }
        case let .list(_, path):
            self[keyPath: path].map {
                AnalyzedValue(
                    value: .list($0.values),
                    confidence: $0.confidence,
                    provenance: Self.provenance($0.provenance),
                )
            }
        case .condition:
            condition.map {
                AnalyzedValue(
                    value: .text($0.value.rawValue),
                    confidence: $0.confidence,
                    provenance: Self.provenance($0.provenance),
                )
            }
        }
    }

    /// An analysis source this app does not know counts as AI (the contract's rule).
    private static func provenance(_ source: Components.Schemas.AnalysisProvenance) -> ReviewProvenance {
        switch ReviewProvenance(source.value1?.rawValue ?? source.value2 ?? "ai") {
        case .other: .ai
        case let known: known
        }
    }
}
