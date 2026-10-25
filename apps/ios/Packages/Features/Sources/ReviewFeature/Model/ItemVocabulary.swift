import Core
import Foundation

/// Listora's canonical item vocabulary and each marketplace's copy limits, read from
/// `Resources/vocabulary.json`. That file is a copy of @listora/analysis's (`vocabulary.ts` and
/// `marketplace-copy.ts`), and `packages/analysis/src/ios-vocabulary.test.ts` keeps it equal. A
/// value the app does not know (a server newer than the app) still shows, humanized.
struct ItemVocabulary: Decodable, Sendable {
    struct Category: Decodable, Sendable {
        let category: String
        let subcategories: [String]
    }

    struct CopyLimits: Decodable, Equatable, Sendable {
        let title: Int
        let description: Int
        let hashtags: Int
    }

    let categories: [Category]
    let departments: [String]
    let sizeSystems: [String]
    let conditions: [String]
    let copyLimits: [String: CopyLimits]

    static let shared: ItemVocabulary = {
        guard let url = Bundle.module.url(forResource: "vocabulary", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let vocabulary = try? JSONDecoder().decode(ItemVocabulary.self, from: data)
        else {
            // The file ships inside the module; a build without it is broken.
            preconditionFailure("ReviewFeature's vocabulary.json is missing or unreadable")
        }
        return vocabulary
    }()

    /// Every category path (`<category>/<subcategory>`), in order.
    var categoryPaths: [String] {
        categories.flatMap { category in category.subcategories.map { "\(category.category)/\($0)" } }
    }

    /// "Clothing › Tops › T-shirts" for `clothing/tops/t_shirts`.
    static func categoryName(_ path: String) -> String {
        VocabularyName.category(path)
    }

    static func departmentName(_ value: String) -> String {
        humanize(value)
    }

    static func sizeSystemName(_ value: String) -> String {
        switch value {
        case "letter": "Letter (XS to XXXL)"
        case "numeric": "Numeric"
        case "waist_inseam": "Waist x inseam"
        case "us": "US"
        case "uk": "UK"
        case "eu": "EU"
        case "one_size": "One size"
        default: humanize(value)
        }
    }

    static func conditionName(_ value: String) -> String {
        switch value {
        case "new_with_tags": "New with tags"
        case "new_without_tags": "New without tags"
        case "new_with_defects": "New with defects"
        case "pre_owned_excellent": "Pre-owned, excellent"
        case "pre_owned_good": "Pre-owned, good"
        case "pre_owned_fair": "Pre-owned, fair"
        default: humanize(value)
        }
    }

    /// `snake_case` ids as words: "tank_tops" is "Tank tops".
    static func humanize(_ id: String) -> String {
        VocabularyName.humanize(id)
    }
}
