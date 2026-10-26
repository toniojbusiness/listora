import Foundation

/// The rules that map one phrase to changes, in the order ``VoiceCorrectionParser`` tries them.
extension VoiceCorrectionParser {
    static func noFlaws(_ text: String, _: VoiceParseContext) -> [VoiceChange]? {
        let pattern =
            #/
                (?i)(?:there\ are\ |it\ has\ |has\ )?(?:no|zero)\ (?:flaws|defects|stains|holes|damage|issues|
                problems)(?:\ (?:or|and)\ (?:flaws|defects|stains|holes|tears|damage|issues|problems))*|flawless
            /#
        return text.wholeMatch(of: pattern) == nil ? nil : [.set(.flaws, .list([]))]
    }

    /// "paid four dollars at Goodwill", "cost me $3.50", "bought it for 12 bucks from the bins".
    static func cost(_ text: String, _ context: VoiceParseContext) -> [VoiceChange]? {
        let pattern =
            #/
                (?i)(?:i\ )?(?:paid|spent|cost(?:\ me)?|bought\ (?:it\ |this\ |these\ )?for|got\ (?:it\ |this\ |
                these\ )?for|picked\ (?:it\ |this\ )?up\ for)\s+(.+)
            /#
        guard let match = text.wholeMatch(of: pattern) else { return nil }
        let rest = String(match.1)
        if let cents = SpokenAmount.cents(rest) {
            return [.cost(cents)]
        }
        // The source after the amount: the last " at " or " from ".
        guard let range = rest.ranges(of: /(?i)\s+(?:at|from)\s+/).last,
              let cents = SpokenAmount.cents(String(rest[..<range.lowerBound])),
              let source = sourceName(String(rest[range.upperBound...]), context)
        else { return nil }
        return [.cost(cents), .purchaseSource(source)]
    }

    /// "price at 30", "list it for $29.99", "sell for twenty five", "asking 40".
    static func listPrice(_ text: String, _: VoiceParseContext) -> [VoiceChange]? {
        let pattern =
            #/
                (?i)(?:listing\ price|list\ price|price(?:\ it)?|list(?:\ it)?|sell(?:\ it)?|asking(?:\ price)?|
                ask)(?:\s+(?:is|at|for|to|of|should\ be))?\s+(.+)
            /#
        guard let match = text.wholeMatch(of: pattern), let cents = SpokenAmount.cents(String(match.1)), cents > 0
        else { return nil }
        return [.listPrice(cents)]
    }

    /// "new with tags", "NWT", "in excellent condition", "condition is gently used".
    static func condition(_ text: String, _: VoiceParseContext) -> [VoiceChange]? {
        let phrase = words(text)
            .replacing(/^(?:condition(?: is)?|in)\s/, with: "")
            .replacing(/\scondition$/, with: "")
        guard let value = VoiceWords.conditionPhrases[phrase] else { return nil }
        return [.set(.condition, .text(value))]
    }

    /// "size medium", "size 8 and a half", "size 32 by 30", "size US 9", "size one size".
    static func size(_ text: String, _ context: VoiceParseContext) -> [VoiceChange]? {
        guard let match = text.wholeMatch(of: /(?i)(?:size|sized)(?: is)?\s+(.+)/) else { return nil }
        return sizeChanges(String(match.1), context, afterSize: true)
    }

    /// "women's medium", "men's size large".
    static func departmentAndSize(_ text: String, _ context: VoiceParseContext) -> [VoiceChange]? {
        guard let match = text.wholeMatch(of: /(?i)(\S+)\s+(size\s+)?(.+)/),
              let department = VoiceWords.departments[words(String(match.1))],
              let size = sizeChanges(String(match.3), context, afterSize: match.2 != nil)
        else { return nil }
        return [.set(.department, .text(department))] + size
    }

    /// "medium", "extra large", "one size": the size words a phrase can be on its own.
    static func bareSize(_ text: String, _ context: VoiceParseContext) -> [VoiceChange]? {
        sizeChanges(text, context, afterSize: false)
    }

    static func sizeChanges(_ raw: String, _ context: VoiceParseContext, afterSize: Bool)
        -> [VoiceChange]?
    {
        func sized(_ label: String, _ system: String) -> [VoiceChange] {
            [.set(.sizeLabel, .text(label)), .set(.sizeSystem, .text(system))]
        }
        if VoiceWords.oneSize.contains(words(raw)) {
            return sized("One size", "one_size")
        }
        let token = words(raw).replacing(/\ssize$/, with: "")
        if let label = VoiceWords.letterSizes[token] ?? (afterSize ? VoiceWords.letterOnly[token] : nil) {
            return sized(label, "letter")
        }
        guard afterSize else { return nil }
        if let match = token.wholeMatch(of: /(.+?)\s*(?:by|x)\s*(.+)/),
           let waist = SpokenAmount.number(String(match.1)), let inseam = SpokenAmount.number(String(match.2)),
           (20 ... 60).contains(waist), (20 ... 40).contains(inseam)
        {
            return sized("\(waist)x\(inseam)", "waist_inseam")
        }
        if let match = token.wholeMatch(of: /(us|uk|eu|european|british)\s+(.+)/),
           let number = sizeNumber(String(match.2))
        {
            let system = switch match.1 {
            case "uk", "british": "uk"
            case "eu", "european": "eu"
            default: "us"
            }
            return sized(number, system)
        }
        if let number = sizeNumber(token) {
            return sized(number, context.category?.hasPrefix("shoes") == true ? "us" : "numeric")
        }
        return nil
    }

    /// "8", "8.5", "eight and a half", "10 and a half" as a size label.
    static func sizeNumber(_ text: String) -> String? {
        if text.wholeMatch(of: /\d{1,2}(?:\.5)?/) != nil {
            return text
        }
        if let match = text.wholeMatch(of: /(.+) and a half/), let whole = SpokenAmount.number(String(match.1)),
           whole < 100
        {
            return "\(whole).5"
        }
        if let whole = SpokenAmount.number(text), whole < 100 {
            return "\(whole)"
        }
        return nil
    }

    /// "women's", "for men", "department kids".
    static func department(_ text: String, _: VoiceParseContext) -> [VoiceChange]? {
        let phrase = words(text).replacing(/^(?:department(?: is)?|for)\s/, with: "")
        return VoiceWords.departments[phrase].map { [.set(.department, .text($0))] }
    }

    /// "navy", "black and white", "the color is gray", "colors navy and cream".
    static func colors(_ text: String, _: VoiceParseContext) -> [VoiceChange]? {
        let phrase = words(text).replacing(/^(?:colou?rs?(?: (?:is|are))?)\s/, with: "")
        guard let values = list(phrase, { name in
            let name = name.replacing(/\scolou?r(?:ed)?$/, with: "")
            return VoiceWords.colorNames[name] ?? vocabularyID(name, in: ItemVocabulary.shared.colors)
        }) else { return nil }
        return [.set(.colors, .list(values))]
    }

    /// "striped", "the pattern is plaid", "leopard print".
    static func pattern(_ text: String, _: VoiceParseContext) -> [VoiceChange]? {
        let phrase = words(text).replacing(/^pattern(?: is)?\s/, with: "")
        guard phrase != "other",
              let value = VoiceWords.patternNames[phrase] ?? vocabularyID(phrase, in: ItemVocabulary.shared.patterns)
        else { return nil }
        return [.set(.pattern, .text(value))]
    }

    /// "100% cotton", "made of wool", "60% cotton 40% polyester", "material is denim".
    static func materials(_ text: String, _: VoiceParseContext) -> [VoiceChange]? {
        var phrase = words(text)
        let prefixed = phrase.firstMatch(of: /^(?:made (?:of|from|out of)|materials?(?: (?:is|are))?|fabric(?: is)?)\s/)
        if let prefixed {
            phrase.removeSubrange(prefixed.range)
        }
        // "60% cotton 40% polyester": a new material at each percentage.
        phrase = phrase.replacing(/\s(?=\d+ ?(?:%|percent))/, with: " and ")
        guard let values = list(phrase, { name in
            let name = name.replacing(/^\d+ ?(?:%|percent)\s/, with: "")
            guard prefixed != nil || !VoiceWords.materialsNeedingPrefix.contains(name) else { return nil }
            return VoiceWords.materialNames[name] ?? vocabularyID(name, in: ItemVocabulary.shared.materials)
        }) else { return nil }
        return [.set(.materials, .list(values))]
    }

    /// "sweater", "it's a pair of jeans", "category is sneakers".
    static func category(_ text: String, _: VoiceParseContext) -> [VoiceChange]? {
        let phrase = words(text).replacing(/^(?:category(?: is)?|(?:a )?pair of)\s/, with: "")
        return VoiceWords.categoryNames[phrase].map { [.set(.category, .text($0))] }
    }

    /// "brand Patagonia", "the brand is Free People", "made by Levi's", "by Coach".
    static func brand(_ text: String, _: VoiceParseContext) -> [VoiceChange]? {
        guard let match = text.wholeMatch(of: /(?i)(?:brand(?: name)?(?: is)?|made by|by)\s+(.+)/),
              let brand = name(String(match.1), limit: ReviewFieldKey.brand.maxLength)
        else { return nil }
        return [.set(.brand, .text(brand))]
    }

    /// Details said by name: "title ...", "style number ...", "keywords ...", "notes ...".
    static func labeled(_ text: String, _: VoiceParseContext) -> [VoiceChange]? {
        if let match = text.wholeMatch(of: /(?i)(?:title|listing title|call it|name it)(?: is| should be)?\s+(.+)/) {
            return sentence(String(match.1), limit: ReviewFieldKey.title.maxLength).map { [.set(.title, .text($0))] }
        }
        if let match = text.wholeMatch(of: /(?i)(?:product name|model name|model)(?: is)?\s+(.+)/) {
            return name(String(match.1), limit: ReviewFieldKey.productName.maxLength)
                .map { [.set(.productName, .text($0))] }
        }
        if let match = text.wholeMatch(of: /(?i)style(?: number| no\.?| #)?(?: is)?\s+([a-z0-9][a-z0-9 \-]*)/) {
            let style = match.1.uppercased().replacingOccurrences(of: " ", with: "")
            return style.count <= ReviewFieldKey.styleNumber.maxLength ? [.set(.styleNumber, .text(style))] : nil
        }
        if let match = text.wholeMatch(of: /(?i)(?:add )?(?:keywords?|hashtags?)(?: (?:are|is))?\s+(.+)/) {
            let keywords = String(match.1).split(separator: /\s*(?:,|\band\b)\s*/).map {
                $0.trimmingCharacters(in: .whitespaces)
            }.filter { !$0.isEmpty && $0.count <= ReviewFieldKey.keywords.maxLength }
            return keywords.isEmpty ? nil : keywords.map { .add(.keywords, $0) }
        }
        if let match = text.wholeMatch(of: /(?i)(?:condition )?notes?(?: (?:are|is))?\s+(.+)/) {
            return sentence(String(match.1), limit: ReviewFieldKey.conditionNotes.maxLength)
                .map { [.set(.conditionNotes, .text($0))] }
        }
        return nil
    }

    /// "from Goodwill", "got it at the Salvation Army", "thrifted it at an estate sale for $3".
    static func source(_ text: String, _ context: VoiceParseContext) -> [VoiceChange]? {
        let pattern =
            #/
                (?i)(?:(?:i\ )?(?:got|bought|found|picked\ up|thrifted|sourced|scored)(?:\ (?:it|this|these|
                them|one))?(?:\ up)?\ )?(?:at|from)\s+(.+)
            /#
        guard let match = text.wholeMatch(of: pattern) else { return nil }
        let rest = String(match.1)
        if let range = rest.ranges(of: /(?i)\s+for\s+/).last,
           let cents = SpokenAmount.cents(String(rest[range.upperBound...])),
           let source = sourceName(String(rest[..<range.lowerBound]), context)
        {
            return [.purchaseSource(source), .cost(cents)]
        }
        return sourceName(rest, context).map { [.purchaseSource($0)] }
    }

    /// A place name as the seller writes it: a recent source's spelling, or capitalized words.
    /// An era ("the nineties") is no place.
    static func sourceName(_ raw: String, _ context: VoiceParseContext) -> String? {
        let place = raw.replacing(/(?i)^(?:the|a|an)\s+/, with: "").trimmingCharacters(in: .whitespaces)
        let era =
            #/
                (?i)(?:(?:19|20)?\d0'?s|(?:the\ )?(?:twenties|thirties|forties|fifties|sixties|seventies|
                eighties|nineties)|y2k|vintage)
            /#
        guard !place.isEmpty, place.wholeMatch(of: era) == nil, SpokenAmount.cents(place) == nil else { return nil }
        if let recent = context.recentSources.first(where: { $0.caseInsensitiveCompare(place) == .orderedSame }) {
            return recent
        }
        return name(place, limit: 120)
    }
}
