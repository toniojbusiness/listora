import Foundation
import ListoraAPI

typealias Item = Components.Schemas.Item
typealias ItemDetails = Components.Schemas.ItemDetails
typealias Analysis = Components.Schemas.Analysis
typealias AnalysisResult = Components.Schemas.AnalysisResult

/// The item details the review screen shows, in their canonical order within each section.
enum ReviewFieldKey: String, CaseIterable, Hashable, Sendable {
    case title
    case description
    case brand
    case productName
    case category
    case department
    case sizeLabel
    case sizeSystem
    case colors
    case pattern
    case materials
    case keywords
    case styleNumber
    case rnNumber
    case upc
    case condition
    case conditionNotes
    case flaws

    enum Kind: Equatable, Sendable {
        case text
        case multiline
        /// Several values, edited as one comma-separated line.
        case list
        /// One of the canonical values (or none).
        case choice
    }

    var title: String {
        switch self {
        case .title: "Title"
        case .description: "Description"
        case .brand: "Brand"
        case .productName: "Product name"
        case .category: "Category"
        case .department: "Department"
        case .sizeLabel: "Size"
        case .sizeSystem: "Size type"
        case .colors: "Colors"
        case .pattern: "Pattern"
        case .materials: "Materials"
        case .keywords: "Keywords"
        case .styleNumber: "Style number"
        case .rnNumber: "RN number"
        case .upc: "UPC"
        case .condition: "Condition"
        case .conditionNotes: "Condition notes"
        case .flaws: "Flaws"
        }
    }

    var kind: Kind {
        switch self {
        case .description, .conditionNotes: .multiline
        case .colors, .materials, .keywords, .flaws: .list
        case .category, .department, .sizeSystem, .condition: .choice
        default: .text
        }
    }

    var section: ReviewSection {
        switch self {
        case .title, .description: .copy
        case .condition, .conditionNotes, .flaws: .condition
        default: .details
        }
    }

    /// Every marketplace needs these to list the item, so an empty one asks for attention.
    var isRequiredToList: Bool {
        self == .title || self == .category || self == .condition
    }

    /// The contract's limit on the value's length (`ItemDetails`).
    var maxLength: Int {
        switch self {
        case .title, .productName: 200
        case .description: 10000
        case .brand: 120
        case .styleNumber, .department, .pattern: 64
        case .rnNumber: 16
        case .upc: 14
        case .category: 200
        case .sizeLabel: 32
        case .sizeSystem: 16
        case .conditionNotes: 2000
        case .colors: 32
        case .materials, .keywords: 64
        case .flaws: 200
        case .condition: 32
        }
    }

    /// The canonical values a `choice` field offers, as (value, name) pairs.
    var choices: [(value: String, name: String)] {
        let vocabulary = ItemVocabulary.shared
        return switch self {
        case .category: vocabulary.categoryPaths.map { ($0, ItemVocabulary.categoryName($0)) }
        case .department: vocabulary.departments.map { ($0, ItemVocabulary.departmentName($0)) }
        case .sizeSystem: vocabulary.sizeSystems.map { ($0, ItemVocabulary.sizeSystemName($0)) }
        case .condition: vocabulary.conditions.map { ($0, ItemVocabulary.conditionName($0)) }
        default: []
        }
    }

    /// How a value reads on screen.
    func display(_ value: FieldValue) -> String {
        switch (self, value) {
        case let (.category, .text(text)): ItemVocabulary.categoryName(text)
        case let (.department, .text(text)): ItemVocabulary.departmentName(text)
        case let (.sizeSystem, .text(text)): ItemVocabulary.sizeSystemName(text)
        case let (.condition, .text(text)): ItemVocabulary.conditionName(text)
        case let (.colors, .list(values)), let (.materials, .list(values)):
            values.map(ItemVocabulary.humanize).joined(separator: ", ")
        case let (.pattern, .text(text)): ItemVocabulary.humanize(text)
        case let (_, .list(values)): values.joined(separator: ", ")
        case let (_, .text(text)): text
        }
    }
}

enum ReviewSection: String, CaseIterable, Sendable {
    /// Low-confidence and missing values, shown first so the seller fixes only what matters.
    case attention
    case details
    case condition
    case copy

    var title: String {
        switch self {
        case .attention: "Check these"
        case .details: "Details"
        case .condition: "Condition"
        case .copy: "Title and description"
        }
    }
}

/// A detail's value: text (empty means none) or a list.
enum FieldValue: Equatable, Hashable, Sendable {
    case text(String)
    case list([String])

    var isEmpty: Bool {
        switch self {
        case let .text(text): text.isEmpty
        case let .list(values): values.isEmpty
        }
    }

    /// The value as the seller types it: lists as one comma-separated line.
    var editingText: String {
        switch self {
        case let .text(text): text
        case let .list(values): values.joined(separator: ", ")
        }
    }

    /// What the seller typed, trimmed; lists split on commas.
    static func parse(_ text: String, as kind: ReviewFieldKey.Kind) -> FieldValue {
        switch kind {
        case .list:
            .list(text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty })
        case .text, .multiline, .choice:
            .text(text.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }
}

/// Where a detail's value came from, as the badge next to it says.
enum ReviewProvenance: Equatable, Sendable {
    case ai
    /// Read from a tag or label (the contract's `ocr`).
    case tag
    case barcode
    /// The seller entered or changed it.
    case user
    /// A source added after this app was built; treated as not entered by the seller.
    case other(String)

    init(_ raw: String) {
        switch raw {
        case "ai": self = .ai
        case "ocr": self = .tag
        case "barcode": self = .barcode
        case "user": self = .user
        default: self = .other(raw)
        }
    }

    var label: String {
        switch self {
        case .ai: "AI"
        case .tag: "Tag"
        case .barcode: "Barcode"
        case .user: "You"
        case .other: "Auto"
        }
    }

    var systemImage: String {
        switch self {
        case .ai: "sparkles"
        case .tag: "tag"
        case .barcode: "barcode"
        case .user: "person.fill"
        case .other: "wand.and.stars"
        }
    }
}

/// What the analysis proposed for a detail.
struct AnalyzedValue: Equatable, Sendable {
    let value: FieldValue
    let confidence: Double
    let provenance: ReviewProvenance
}

/// One row of the review screen.
struct ReviewField: Equatable, Identifiable, Sendable {
    let key: ReviewFieldKey
    let value: FieldValue
    /// Nil when the value has no recorded source (nothing was found and nobody entered one).
    let provenance: ReviewProvenance?
    /// The analysis's confidence in the value shown, when the analysis proposed it.
    let confidence: Double?
    /// Proposed below ``ReviewForm/lowConfidence`` and not confirmed by the seller.
    let isLowConfidence: Bool
    /// Empty, and needed to list the item.
    let isMissing: Bool

    var id: ReviewFieldKey {
        key
    }

    var needsAttention: Bool {
        isLowConfidence || isMissing
    }

    var displayValue: String {
        key.display(value)
    }
}
