/// How Listora's canonical vocabulary ids read (`@listora/analysis`'s `vocabulary.ts`): the review
/// screen's choices and the profit dashboard's categories use the same words.
public enum VocabularyName {
    /// "Clothing › Tops › T-shirts" for `clothing/tops/t_shirts`.
    public static func category(_ path: String) -> String {
        path.split(separator: "/").map { humanize(String($0)) }.joined(separator: " › ")
    }

    /// The item type a category path names, in lowercase for a phrase: "leggings" for
    /// `clothing/bottoms/leggings`, and the level above for an "other" (`bags/other` is "bags").
    public static func itemType(_ path: String) -> String {
        let parts = path.split(separator: "/").map(String.init)
        let named = parts.last { $0 != "other" } ?? parts.last ?? path
        return humanize(named).lowercased()
    }

    /// `snake_case` ids as words: "tank_tops" is "Tank tops".
    public static func humanize(_ id: String) -> String {
        if let override = wordOverrides[id] {
            return override
        }
        let words = id.replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    private static let wordOverrides = [
        "t_shirts": "T-shirts",
        "hoodies_sweatshirts": "Hoodies & sweatshirts",
        "jumpsuits_rompers": "Jumpsuits & rompers",
        "sleep_lounge": "Sleep & lounge",
        "suits_sets": "Suits & sets",
        "one_pieces": "One-pieces",
        "cover_ups": "Cover-ups",
    ]
}
