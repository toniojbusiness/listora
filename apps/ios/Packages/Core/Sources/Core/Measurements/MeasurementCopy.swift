import Foundation

/// Writes an item's measurements into its Depop description, in the description's own style: one
/// spec line per measurement ("• Pit to pit: 21\""), after the description's last bulleted line
/// with the same bullet (Listora's default style keeps its specs there), or as their own lines at
/// the end when the description has no bullets. Writing again replaces the lines it wrote before,
/// so changing or clearing a measurement on the review changes the copy too, and it never adds a
/// line twice. Depop buyers ask for measurements before buying vintage and denim; the other
/// marketplaces' copy is left as the analysis wrote it.
public enum MeasurementCopy {
    /// The marketplaces whose description carries the measurements.
    public static let marketplaces: Set<String> = ["depop"]

    /// `copy` for `marketplace` with `measurements` written in; unchanged for another marketplace.
    public static func applying(
        _ measurements: [ItemMeasurement],
        to copy: ListingCopy,
        marketplace: String,
    ) -> ListingCopy {
        guard marketplaces.contains(marketplace) else { return copy }
        var copy = copy
        copy.description = written(measurements, into: copy.description)
        return copy
    }

    /// `description` with one line per measurement, in the order given; no measurements removes
    /// the lines written before.
    public static func written(_ measurements: [ItemMeasurement], into description: String) -> String {
        let names = Set(measurements.map { $0.title.lowercased() })
        let original = description.components(separatedBy: "\n")
        var lines = original.filter { !isMeasurementLine($0, replacing: names) }
        if lines.count == original.count, measurements.isEmpty {
            return description
        }
        lines = collapsedBlankLines(lines)
        guard !measurements.isEmpty else {
            return lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let bullet = lines.lazy.compactMap(bulletMarker).first
        let written = measurements.map { "\(bullet ?? "")\($0.title): \($0.valueText)" }
        if bullet != nil, let last = lines.lastIndex(where: { bulletMarker($0) != nil }) {
            lines.insert(contentsOf: written, at: last + 1)
        } else {
            while lines.last?.trimmingCharacters(in: .whitespaces).isEmpty == true {
                lines.removeLast()
            }
            lines += (lines.isEmpty ? [] : [""]) + written
        }
        return lines.joined(separator: "\n")
    }

    /// The bullet a spec line starts with, with the spacing after it ("• ", "- "); nil for a line
    /// that is not bulleted.
    static func bulletMarker(_ line: String) -> String? {
        line.firstMatch(of: /^\s*[•●▪◦·\-–*]\s+/).map { String($0.output) }
    }

    /// A line Listora wrote for a measurement (any of the review's, with a number and a unit), or
    /// any line for a measurement in `replacing` (the ones being written now, however the seller
    /// typed it).
    static func isMeasurementLine(_ line: String, replacing names: Set<String>) -> Bool {
        let titles = MeasurementKind.allCases.map(\.title).joined(separator: "|")
        let pattern = "^\\s*(?:[•●▪◦·\\-–*]\\s*)?(\(titles))\\s*:\\s*\\d+(?:\\.\\d+)?\\s*(?:\"|”|in|inches|cm)\\s*$"
        if let regex = try? Regex(pattern).ignoresCase(), line.wholeMatch(of: regex) != nil {
            return true
        }
        guard let label = line.firstMatch(of: /^\s*(?:[•●▪◦·\-–*]\s*)?([^:]{1,40}):/) else { return false }
        return names.contains(label.output.1.trimmingCharacters(in: .whitespaces).lowercased())
    }

    /// No two blank lines in a row where a removed line left a gap.
    private static func collapsedBlankLines(_ lines: [String]) -> [String] {
        var result: [String] = []
        for line in lines {
            let blank = line.trimmingCharacters(in: .whitespaces).isEmpty
            if blank, result.last?.trimmingCharacters(in: .whitespaces).isEmpty == true {
                continue
            }
            result.append(line)
        }
        return result
    }
}
