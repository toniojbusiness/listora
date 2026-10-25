import Foundation

/// Dollar amounts and numbers as speech recognition writes them: "$4", "4.50", "four dollars",
/// "four fifty", "a buck", "four dollars and fifty cents", "thirty". Amounts are integer cents.
enum SpokenAmount {
    /// The amount in cents, when all of `text` is one amount; nil otherwise. Amounts above
    /// $99,999.99 (the cost keypad's limit) are not amounts.
    static func cents(_ text: String) -> Int64? {
        var words = tokens(text)
        guard !words.isEmpty else { return nil }
        if words.first == "$" {
            words.removeFirst()
        }
        let cents: Int64? = if let unit = words.firstIndex(where: dollarUnits.contains) {
            dollarsAndCents(Array(words[..<unit]), Array(words[(unit + 1)...]))
        } else if words.last.map(centUnits.contains) == true {
            number(Array(words.dropLast())).flatMap { $0 < 100 ? $0 : nil }
        } else {
            bare(words)
        }
        guard let cents, cents <= maxCents else { return nil }
        return cents
    }

    /// A whole number in digits or words ("8", "thirty two", "a hundred"); nil otherwise.
    static func number(_ text: String) -> Int64? {
        number(tokens(text))
    }

    private static let maxCents: Int64 = 9_999_999
    private static let dollarUnits: Set<String> = ["dollar", "dollars", "buck", "bucks", "usd"]
    private static let centUnits: Set<String> = ["cent", "cents"]

    /// "4 dollars", "four dollars and fifty cents", "4 dollars 50", "a buck", "4.50 dollars".
    private static func dollarsAndCents(_ dollars: [String], _ rest: [String]) -> Int64? {
        if dollars.count == 1, dollars[0].contains("."), let cents = decimalCents(dollars[0]) {
            return rest.isEmpty ? cents : nil
        }
        let whole: Int64
        if dollars == ["a"] {
            whole = 100
        } else if let value = number(dollars) {
            whole = value * 100
        } else {
            return nil
        }
        var rest = rest
        if rest.first == "and" {
            rest.removeFirst()
        }
        if rest.last.map(centUnits.contains) == true {
            rest.removeLast()
        }
        guard !rest.isEmpty else { return whole }
        guard let fraction = number(rest), fraction < 100 else { return nil }
        return whole + fraction
    }

    /// No unit: "4.50", "30", "thirty", or "four fifty" ($4.50).
    private static func bare(_ words: [String]) -> Int64? {
        if words.count == 1, let cents = decimalCents(words[0]) {
            return cents
        }
        if let whole = number(words) {
            return whole * 100
        }
        // "four fifty", "twelve ninety nine": dollars, then two-digit cents.
        for split in 1 ..< words.count {
            if let dollars = number(Array(words[..<split])), (1 ... 999).contains(dollars),
               let fraction = number(Array(words[split...])), (10 ... 99).contains(fraction)
            {
                return dollars * 100 + fraction
            }
        }
        return nil
    }

    /// "4", "4.5", "4.50" as cents.
    private static func decimalCents(_ word: String) -> Int64? {
        guard let match = word.wholeMatch(of: /(\d{1,5})(?:\.(\d{1,2}))?/) else { return nil }
        let whole = Int64(match.1) ?? 0
        let fraction = match.2.map { Int64(String($0).padding(toLength: 2, withPad: "0", startingAt: 0)) ?? 0 } ?? 0
        return whole * 100 + fraction
    }

    static let units: [String: Int64] = [
        "zero": 0, "oh": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
        "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
        "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
    ]
    static let tens: [String: Int64] = [
        "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80,
        "ninety": 90,
    ]

    /// Number words or one run of digits, nothing else.
    private static func number(_ words: [String]) -> Int64? {
        guard !words.isEmpty else { return nil }
        if words.count == 1, words[0].allSatisfy(\.isNumber), words[0].count <= 6 {
            return Int64(words[0])
        }
        var reader = NumberWords()
        for (index, word) in words.enumerated() {
            // "a" only starts "a hundred" or "a thousand".
            if word == "a" || word == "an", index > 0 || words.count == 1 {
                return nil
            }
            guard reader.read(word) else { return nil }
        }
        return reader.value
    }

    /// Lowercased words; "$4.50" is "$", "4.50"; hyphens and thousands separators go.
    private static func tokens(_ text: String) -> [String] {
        var text = text.lowercased()
            .replacingOccurrences(of: "-", with: " ")
            .replacing(/(\d),(\d{3})/) { "\($0.1)\($0.2)" }
        text = text.replacingOccurrences(of: "$", with: "$ ")
        return text.split(whereSeparator: \.isWhitespace)
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: ".,!?;:")) }
            .filter { !$0.isEmpty }
    }
}

/// Reads number words left to right: units and teens, tens, "hundred", "thousand".
private struct NumberWords {
    private enum Previous {
        case start
        case unit
        case ten
        case scale
    }

    private var total: Int64 = 0
    private var current: Int64 = 0
    private var previous = Previous.start

    var value: Int64 {
        total + current
    }

    /// Takes the next word; false when it cannot follow the words before it.
    mutating func read(_ word: String) -> Bool {
        if let unit = SpokenAmount.units[word] ?? (word == "a" || word == "an" ? 1 : nil) {
            // "twenty one" is fine; "one two" and "twelve one" are not.
            guard previous != .unit else { return false }
            current += unit
            previous = .unit
        } else if let ten = SpokenAmount.tens[word] {
            guard previous == .start || previous == .scale else { return false }
            current += ten
            previous = .ten
        } else if word == "hundred" {
            guard current > 0, current < 100 else { return false }
            current *= 100
            previous = .scale
        } else if word == "thousand" {
            guard value > 0 else { return false }
            total = (total + current) * 1000
            current = 0
            previous = .scale
        } else {
            // "one hundred and twenty"
            return word == "and" && previous == .scale
        }
        return true
    }
}
