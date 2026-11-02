import Foundation
import ListoraAPI

/// How the card words the server's answer: the item's details, the web research, the household's
/// own sales, and money, in whole dollars.
extension ScanCard {
    /// "Size 6 · Nylon · Vintage 1990s · Pre-owned good", whatever the AI could tell.
    static func subtitle(_ identity: Components.Schemas.ScanIdentity) -> String? {
        let details = [
            identity.sizeLabel.map { "Size \($0)" },
            identity.material.map(capitalized),
            identity.era.flatMap { $0 == "current" ? nil : capitalized($0) },
            identity.condition.map(conditionName),
        ].compactMap(\.self)
        return details.isEmpty ? nil : details.joined(separator: " · ")
    }

    /// How sure the read is of what the item is, in words.
    static func readConfidence(_ confidence: Double) -> String {
        switch confidence {
        case 0.8...: "Sure of what it is"
        case 0.6 ..< 0.8: "Fairly sure of what it is"
        default: "Not sure what it is: the tag would help"
        }
    }

    private static func capitalized(_ text: String) -> String {
        text.prefix(1).uppercased() + text.dropFirst()
    }

    static func webInfo(_ research: Components.Schemas.ScanResearch) -> WebInfo {
        let resale = research.resale.map { resale in
            let sites = resale.sources.map(\.site).joined(separator: ", ")
            return "Asks \(range(resale.low, resale.high) ?? "") on \(sites)"
        }
        let models = research.retail.flatMap { retail in
            retail.models.count > 1 ? "Models: " + retail.models.joined(separator: ", ") : nil
        }
        return WebInfo(
            label: research.label,
            summary: research.summary,
            resale: resale,
            models: models,
            found: research.status.value1 == .found,
        )
    }

    /// "3 sold · $25-$29 · median $28" on one marketplace.
    static func ownSales(_ line: Components.Schemas.ScanOwnSales) -> OwnSales {
        let count = line.soldCount == 1 ? "1 sold" : "\(line.soldCount) sold"
        return OwnSales(
            marketplace: marketplaceName(line.marketplace),
            label: line.label,
            summary: [count, range(line.low, line.high), "median \(dollars(line.median))"]
                .compactMap(\.self)
                .joined(separator: " · "),
            displayOnly: line.displayOnly,
        )
    }

    static func dollars(_ money: Components.Schemas.Money) -> String {
        (Decimal(money.amountCents) / 100)
            .formatted(.currency(code: money.currency.rawValue).precision(.fractionLength(0)))
    }

    /// "$25-$29", or one amount when both ends round to it; nil without both.
    static func range(_ low: Components.Schemas.Money?, _ high: Components.Schemas.Money?) -> String? {
        guard let low, let high else { return nil }
        let lowText = dollars(low)
        let highText = dollars(high)
        return lowText == highText ? lowText : "\(lowText)-\(highText)"
    }

    static func marketplaceName(_ marketplace: Components.Schemas.Marketplace) -> String {
        switch marketplace.value1 {
        case .ebay?: "eBay"
        case .depop?: "Depop"
        case .poshmark?: "Poshmark"
        case .mercari?: "Mercari"
        case nil: marketplace.value2 ?? ""
        }
    }

    static func conditionName(_ condition: Components.Schemas.ItemCondition) -> String {
        switch condition {
        case .newWithTags: "New with tags"
        case .newWithoutTags: "New without tags"
        case .newWithDefects: "New with defects"
        case .preOwnedExcellent: "Pre-owned excellent"
        case .preOwnedGood: "Pre-owned good"
        case .preOwnedFair: "Pre-owned fair"
        }
    }
}
