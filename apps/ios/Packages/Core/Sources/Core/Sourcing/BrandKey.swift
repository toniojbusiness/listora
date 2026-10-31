import Foundation

/// The key two brands are compared by: this app's copy of `brandKey` in @listora/sourcing, kept
/// equal by the offline call's golden cases (`OfflineScanCallTests`). Lowercase, accents and
/// punctuation dropped ("Levi's" and "LEVI" are both `levi`), a plural `s` dropped from each word,
/// joiners and company words left out, then the first word (two when the first is too common to
/// name a brand alone: "old navy", "american eagle"). A match key, not a display name.
public enum BrandKey {
    static let ignoredWords: Set<String> = ["and", "by", "co", "company", "inc", "the", "outfitter"]
    static let sharedLeadingWords: Set<String> = [
        "american", "banana", "free", "j", "new", "old", "polo", "true", "urban",
    ]

    /// The brand's key, or nil for a brand with no letters or digits.
    public static func of(_ brand: String?) -> String? {
        guard let brand else { return nil }
        let folded = String(String.UnicodeScalarView(
            brand.decomposedStringWithCompatibilityMapping.unicodeScalars.filter { !isMark($0) },
        ))
        .lowercased()
        .replacingOccurrences(of: "&", with: " and ")
        .replacingOccurrences(of: "'", with: "")
        .replacingOccurrences(of: "\u{2019}", with: "")
        let words = split(folded)
            .map { word in word.utf16.count > 3 && word.hasSuffix("s") ? String(word.dropLast()) : word }
            .filter { !ignoredWords.contains($0) }
        guard let first = words.first else { return nil }
        if sharedLeadingWords.contains(first), words.count > 1 {
            return "\(first) \(words[1])"
        }
        return first
    }

    /// The runs of letters and digits, as JavaScript's `split(/[^\p{L}\p{N}]+/u)` keeps them.
    private static func split(_ text: String) -> [String] {
        var words: [String] = []
        var current = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            if isLetterOrNumber(scalar) {
                current.append(scalar)
            } else if !current.isEmpty {
                words.append(String(current))
                current = String.UnicodeScalarView()
            }
        }
        if !current.isEmpty {
            words.append(String(current))
        }
        return words
    }

    private static func isMark(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .nonspacingMark, .spacingMark, .enclosingMark: true
        default: false
        }
    }

    private static func isLetterOrNumber(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber:
            true
        default:
            false
        }
    }
}
