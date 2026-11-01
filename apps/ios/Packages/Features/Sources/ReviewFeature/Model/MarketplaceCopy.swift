import Core
import Foundation
import ListoraAPI

/// One marketplace's version of the listing copy: what the analysis wrote, and the seller's edit
/// of it if any (kept by ``ListingCopyStore``).
struct MarketplaceCopy: Equatable, Identifiable, Sendable {
    let marketplace: String
    let suggested: ListingCopy
    var edited: ListingCopy?

    var id: String {
        marketplace
    }

    var current: ListingCopy {
        edited ?? suggested
    }

    var name: String {
        Formatting.marketplaceName(marketplace)
    }

    var limits: ItemVocabulary.CopyLimits? {
        ItemVocabulary.shared.copyLimits[marketplace]
    }

    /// Depop listings have no title; the title is Listora's short headline for the item.
    var hasTitle: Bool {
        marketplace != "depop"
    }

    var showsHashtags: Bool {
        (limits?.hashtags ?? 0) > 0
    }

    /// The copy as `copy` would reach the marketplace's description field: on Depop the hashtags
    /// follow on their own line (`depopDescription` in @listora/analysis).
    static func listedDescription(_ copy: ListingCopy, hashtags: Bool) -> String {
        guard hashtags, !copy.hashtags.isEmpty else { return copy.description }
        return copy.description + "\n\n" + copy.hashtags.map { "#\($0)" }.joined(separator: " ")
    }

    /// What breaks the marketplace's limits, in words; empty when the copy fits. Lengths count
    /// UTF-16 code units, as the server does.
    static func problems(of copy: ListingCopy, marketplace: String) -> [String] {
        guard let limits = ItemVocabulary.shared.copyLimits[marketplace] else { return [] }
        let name = Formatting.marketplaceName(marketplace)
        var problems: [String] = []
        let titleLength = copy.title.utf16.count
        if marketplace != "depop", titleLength > limits.title {
            problems.append("The title is \(titleLength) characters; \(name) allows \(limits.title).")
        }
        if copy.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, marketplace != "depop" {
            problems.append("Add a title.")
        }
        let description = listedDescription(copy, hashtags: limits.hashtags > 0).utf16.count
        if description > limits.description {
            let what = limits.hashtags > 0 ? "The description with its hashtags" : "The description"
            problems.append("\(what) is \(description) characters; \(name) allows \(limits.description).")
        }
        if copy.hashtags.count > limits.hashtags, limits.hashtags > 0 {
            problems.append("\(name) allows \(limits.hashtags) hashtags.")
        }
        return problems
    }

    var problems: [String] {
        Self.problems(of: current, marketplace: marketplace)
    }

    /// The analysis's variants merged with the seller's saved edits, in the server's order, with
    /// the item's measurements written into the descriptions that carry them (``MeasurementCopy``).
    static func copies(
        result: AnalysisResult?,
        edits: [String: ListingCopy],
        measurements: [ItemMeasurement] = [],
    ) -> [MarketplaceCopy] {
        (result?.variants ?? []).map { variant in
            let marketplace = variant.marketplace.id
            let suggested = MeasurementCopy.applying(
                measurements,
                to: ListingCopy(
                    title: variant.title,
                    description: variant.description,
                    hashtags: variant.hashtags ?? [],
                ),
                marketplace: marketplace,
            )
            let edit = edits[marketplace].map {
                MeasurementCopy.applying(measurements, to: $0, marketplace: marketplace)
            }
            return MarketplaceCopy(
                marketplace: marketplace,
                suggested: suggested,
                edited: edit == suggested ? nil : edit,
            )
        }
    }
}
