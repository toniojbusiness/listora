import Core
import Foundation

/// The measurement rule: "pit to pit 21", "length 28 inches", "inseam thirty and a half", and
/// several in one breath ("pit to pit 21 length 28").
extension VoiceCorrectionParser {
    /// The spoken names of each measurement, as ``words(_:)`` writes them.
    static let measurementNames: [(spoken: String, kind: MeasurementKind)] = [
        ("pit to pit", .pitToPit), ("pit 2 pit", .pitToPit), ("p2p", .pitToPit), ("p to p", .pitToPit),
        ("armpit to armpit", .pitToPit), ("front rise", .rise), ("rise", .rise), ("inseam", .inseam),
        ("waist", .waist), ("length", .length),
    ]

    static func measurements(_ text: String, _: VoiceParseContext) -> [VoiceChange]? {
        let phrase = words(text)
        let alternatives = measurementNames.map { NSRegularExpression.escapedPattern(for: $0.spoken) }
        guard let names = try? Regex<Substring>("\\b(?:\(alternatives.joined(separator: "|")))\\b") else {
            return nil
        }
        let found = phrase.matches(of: names)
        guard let first = found.first, first.range.lowerBound == phrase.startIndex else { return nil }
        var changes: [VoiceChange] = []
        for (index, match) in found.enumerated() {
            let end = index + 1 < found.count ? found[index + 1].range.lowerBound : phrase.endIndex
            let spoken = String(phrase[match.range])
            guard let kind = measurementNames.first(where: { $0.spoken == spoken })?.kind,
                  let (value, unit) = measurementValue(String(phrase[match.range.upperBound ..< end]))
            else { return nil }
            changes.append(.measurement(ItemMeasurement(name: kind.rawValue, value: value, unit: unit)))
        }
        return changes
    }

    /// "21", "21.5", "is 21 inches", "twenty one and a half", "21 point 5", "53 cm": the number
    /// and its unit (inches unless centimeters were said); nil for anything else.
    static func measurementValue(_ raw: String) -> (Double, ItemMeasurement.Unit)? {
        var text = raw.trimmingCharacters(in: .whitespaces)
            .replacing(/^(?:is|of|at|:)\s*/, with: "")
            .replacing(/\s+(?:and|also|plus|then)$/, with: "")
            .trimmingCharacters(in: .whitespaces)
        var unit = ItemMeasurement.Unit.inches
        if let suffix = text.firstMatch(of: /\s*(?:inches|inch|in|"|”|cm|centimeters?|centimetres?)$/) {
            if suffix.output.contains("cm") || suffix.output.contains("cent") {
                unit = .centimeters
            }
            text.removeSubrange(suffix.range)
        }
        let value: Double? = if let match = text.wholeMatch(of: /(\d{1,3}(?:\.\d{1,2})?)/) {
            Double(String(match.1))
        } else if let match = text.wholeMatch(of: /(.+?)\s+and\s+(?:a\s+)?(half|quarter|three quarters)/),
                  let whole = SpokenAmount.number(String(match.1))
        {
            Double(whole) + (match.2 == "half" ? 0.5 : match.2 == "quarter" ? 0.25 : 0.75)
        } else if let match = text.wholeMatch(of: /(.+?)\s+point\s+(\d|one|two|three|four|five|six|seven|eight|nine)/),
                  let whole = SpokenAmount.number(String(match.1)),
                  let tenth = SpokenAmount.number(String(match.2))
        {
            Double(whole) + Double(tenth) / 10
        } else {
            SpokenAmount.number(text).map(Double.init)
        }
        guard let value, value > 0, value < 1000 else { return nil }
        return (value, unit)
    }
}
