/// How Listora's canonical vocabulary ids read (`@listora/analysis`'s `vocabulary.ts`): the review
/// screen's choices and the profit dashboard's categories use the same words.
public enum VocabularyName {
    /// "Clothing › Tops › T-shirts" for `clothing/tops/t_shirts`.
    public static func category(_ path: String) -> String {
        path.split(separator: "/").map { humanize(String($0)) }.joined(separator: " › ")
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
