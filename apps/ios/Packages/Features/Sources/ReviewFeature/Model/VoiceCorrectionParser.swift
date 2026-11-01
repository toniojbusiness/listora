import Foundation

/// What the parser needs to know about the item.
struct VoiceParseContext: Equatable, Sendable {
    /// The item's category path; a plain number is a US shoe size on shoes.
    var category: String?
    /// The seller's recent purchase sources; a spoken source takes their spelling.
    var recentSources: [String] = []
}

/// A correction as changes, plus the phrases no rule understood.
struct VoiceParse: Equatable, Sendable {
    var changes: [VoiceChange]
    /// The phrases no rule mapped, as said. Only these go to the server's text model.
    var unmatched: [String]
}

/// Reads a spoken correction ("size medium, small stain on the left cuff, paid four dollars at
/// Goodwill") into proposed changes with fixed rules, on the device and for free, so routine
/// corrections never cost an AI call. A phrase none of the rules understands is returned
/// unmatched, for the server's text model.
///
/// The transcript is split into phrases at punctuation; a phrase no rule takes as a whole is
/// split again at "and", "also", "plus", and "then". Each phrase loses its filler first ("um",
/// "it's a", "the"). Canonical details get canonical values from the vocabulary, amounts are
/// integer cents, and a later change to the same detail replaces an earlier one.
enum VoiceCorrectionParser {
    static func parse(_ transcript: String, context: VoiceParseContext = VoiceParseContext()) -> VoiceParse {
        var changes: [VoiceChange] = []
        var unmatched: [String] = []
        var previous: [VoiceChange] = []
        for phrase in phrases(transcript) {
            let pieces = connectors(phrase)
            for piece in pieces.count > 1 && rules(phrase, context) == nil ? pieces : [phrase] {
                guard let found = rules(piece, context) ?? flaw(piece) else {
                    if !isFiller(piece) {
                        unmatched.append(piece)
                    }
                    previous = []
                    continue
                }
                // "colors navy, white": a list the recognizer broke at a comma is one list.
                if found.count == 1, previous.count == 1,
                   case let .set(key, .list(more)) = found[0], key == .colors || key == .materials,
                   case let .set(previousKey, .list(values)) = previous[0], previousKey == key,
                   let index = changes.lastIndex(of: previous[0])
                {
                    let joined = VoiceChange.set(key, .list(values + more.filter { !values.contains($0) }))
                    changes[index] = joined
                    previous = [joined]
                    continue
                }
                changes.append(contentsOf: found)
                previous = found
            }
        }
        return VoiceParse(changes: merged(changes), unmatched: unmatched)
    }

    // MARK: Phrases

    /// Splits at commas, semicolons, and sentence ends (not inside "$1,200", "4.50", or "J.Crew").
    static func phrases(_ transcript: String) -> [String] {
        transcript
            .replacingOccurrences(of: "’", with: "'")
            .split(separator: /,(?!\d{3}(?:\D|$))|[;!?]|\.(?=\s|$)/)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    static func connectors(_ phrase: String) -> [String] {
        phrase.split(separator: /(?i)\s+(?:and then|and also|and|also|plus|then)\s+/)
            .map { String($0).trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    static var leadingFiller: Regex<Substring> {
        #/
            (?i)^(?:um+|uh+|er+|hmm+|so|okay|ok|oh|and|also|plus|then|actually|wait|sorry|i\ mean|well|but|
            hey|alright|all\ right|yeah|yes|let's\ see|let\ me\ see)\b\s*
        /#
    }

    static var leadingSubject: Regex<Substring> {
        /(?i)^(?:it's|it is|its|this is|this one is|this one's|that's|that is|the item is|it|this)\s+/
    }

    static var leadingArticle: Regex<Substring> {
        /(?i)^(?:a|an|the)\s+/
    }

    static var trailingFiller: Regex<Substring> {
        /(?i)\s+(?:please|thanks|thank you|i think|actually|too|as well)$/
    }

    /// The phrase without filler, subject, or article in front ("um it's a medium" is "medium").
    static func core(_ phrase: String) -> String {
        var text = phrase.trimmingCharacters(in: .whitespaces)
        var changed = true
        while changed {
            changed = false
            for pattern in [leadingFiller, leadingSubject, leadingArticle, trailingFiller] {
                let stripped = text.replacing(pattern, with: "", maxReplacements: 1)
                    .trimmingCharacters(in: .whitespaces)
                if stripped != text, !stripped.isEmpty {
                    text = stripped
                    changed = true
                }
            }
        }
        return text
    }

    /// Nothing but filler: "um", "no wait", "okay that's it".
    static func isFiller(_ phrase: String) -> Bool {
        let filler =
            #/
                (?i)(?:(?:um+|uh+|er+|hmm+|no|nope|wait|sorry|actually|okay|ok|so|oh|yeah|yes|and|well|
                let\ me\ see|let's\ see|that's\ it|that's\ all|that\ is\ it|that's|it|done|thanks|
                thank\ you)\s*)+
            /#
        return core(phrase).wholeMatch(of: filler) != nil || phrase.wholeMatch(of: filler) != nil
    }

    /// The first rule that takes the whole phrase.
    static func rules(_ phrase: String, _ context: VoiceParseContext) -> [VoiceChange]? {
        let text = core(phrase)
        let rules: [(String, VoiceParseContext) -> [VoiceChange]?] = [
            noFlaws, measurements, cost, listPrice, condition, size, departmentAndSize, department, bareSize, colors,
            pattern, materials, category, brand, labeled, source,
        ]
        for rule in rules {
            if let changes = rule(text, context) {
                return changes
            }
        }
        return nil
    }

    // MARK: Flaws

    static var flawWords: Regex<Substring> {
        #/
            (?i)\b(?:stain(?:s|ed)?|spots?|marks?|holes?|tears?|torn|rips?|ripped|snags?|snagged|pilling|
            pills|pilled|fad(?:e|ed|ing)|discolou?r(?:ation|ed)?|missing|broken|scuffs?|scuffed|
            scratch(?:es|ed)?|cracks?|cracked|cracking|fray(?:ed|ing)?|yellow(?:ing|ed)|odou?r|smells?|
            pulls?|loose\ threads?|peeling|dents?|dented|bleach(?:ed)?\ spots?|lint)\b
        /#
    }

    /// A phrase that names a flaw ("small stain on the left cuff") is that flaw, as said.
    static func flaw(_ phrase: String) -> [VoiceChange]? {
        let text = core(phrase)
        guard text.firstMatch(of: flawWords) != nil else { return nil }
        let described = core(
            text.replacing(/(?i)^(?:there's|there is|there are|has|have|got|i see|i noticed|with)\s+/, with: ""),
        )
        guard let flaw = sentence(described, limit: ReviewFieldKey.flaws.maxLength) else { return nil }
        return [.add(.flaws, flaw)]
    }

    // MARK: Helpers

    /// A later change to a detail replaces an earlier one; an entry added twice is added once.
    static func merged(_ changes: [VoiceChange]) -> [VoiceChange] {
        var result: [VoiceChange] = []
        for change in changes {
            switch change {
            case let .add(key, entry):
                let duplicate = result.contains {
                    if case let .add(other, existing) = $0 {
                        return other == key && existing.caseInsensitiveCompare(entry) == .orderedSame
                    }
                    return false
                }
                if !duplicate {
                    result.append(change)
                }
            default:
                result.removeAll { $0.target == change.target && !isAdd($0) }
                result.append(change)
            }
        }
        return result
    }

    static func isAdd(_ change: VoiceChange) -> Bool {
        if case .add = change {
            return true
        }
        return false
    }

    /// Lowercased, apostrophes straightened, hyphens as spaces, single spaces.
    static func words(_ text: String) -> String {
        text.lowercased()
            .replacingOccurrences(of: "’", with: "'")
            .replacingOccurrences(of: "-", with: " ")
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
    }

    /// Every part of "a, b and c" through `map`, or nil when any part does not map.
    static func list(_ phrase: String, _ map: (String) -> String?) -> [String]? {
        let parts = phrase.split(separator: /\s*(?:,|\band\b|&|\/|\bwith\b)\s*/)
            .map { String($0).trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard !parts.isEmpty else { return nil }
        var values: [String] = []
        for part in parts {
            guard let value = map(part) else { return nil }
            if !values.contains(value) {
                values.append(value)
            }
        }
        return values
    }

    /// The vocabulary id spoken as words: "polka dot" is `polka_dot`.
    static func vocabularyID(_ name: String, in vocabulary: [String]) -> String? {
        let id = name.replacingOccurrences(of: " ", with: "_")
        return vocabulary.contains(id) ? id : nil
    }

    /// A name with each word capitalized when it was all lowercase ("free people" is "Free
    /// People"); a name the recognizer already capitalized ("Levi's", "J.Crew") stays as is.
    static func name(_ raw: String, limit: Int) -> String? {
        let text = raw.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty, text.count <= limit else { return nil }
        guard text == text.lowercased() else { return text }
        return text.split(separator: " ").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }

    /// Text with its first letter capitalized.
    static func sentence(_ raw: String, limit: Int) -> String? {
        let text = raw.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty, text.count <= limit else { return nil }
        return text.prefix(1).uppercased() + text.dropFirst()
    }
}
