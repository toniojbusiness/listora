import Foundation
import ListoraAPI

typealias PricingSuggestion = Components.Schemas.PricingSuggestion

/// What the price screen shows, from the server's `PricingSuggestion`. Every label is the
/// server's, shown exactly as sent ("AI estimate - not based on sold listings", "Recommended (AI
/// estimate)", "No sold data available for this item"); the app never writes its own words about
/// where a price came from, so it can never claim sold data the server does not have.
struct PricingPresentation: Equatable, Sendable {
    /// One part of a floor: cost, fees, shipping, or minimum profit.
    struct FloorLine: Equatable, Sendable {
        let label: String
        let amount: String
    }

    struct Floor: Equatable, Identifiable, Sendable {
        let marketplace: String
        let name: String
        let cents: Int64
        let price: String
        let breakdown: [FloorLine]
        /// The fee table the estimate comes from, and whether it was adjusted to actual fees.
        let feeNote: String

        var id: String {
            marketplace
        }
    }

    struct Tier: Equatable, Identifiable, Sendable {
        let tier: Components.Schemas.PriceTierName
        /// The server's label, for example "Recommended (AI estimate)".
        let label: String
        let cents: Int64
        let price: String

        var id: Components.Schemas.PriceTierName {
            tier
        }
    }

    struct Estimate: Equatable, Sendable {
        /// Always the server's "AI estimate - not based on sold listings".
        let label: String
        let range: String
        let confidence: String
    }

    struct SoldData: Equatable, Identifiable, Sendable {
        let label: String
        let summary: String

        var id: String {
            label
        }
    }

    struct ResearchLink: Equatable, Identifiable, Sendable {
        let label: String
        let url: URL

        var id: URL {
            url
        }
    }

    let floors: [Floor]
    let tiers: [Tier]
    let estimate: Estimate?
    /// Shown in place of sold data when the server has none.
    let noSoldDataMessage: String?
    let soldData: [SoldData]
    let researchLinks: [ResearchLink]

    init(_ suggestion: PricingSuggestion) {
        floors = suggestion.floors.map { floor in
            let breakdown = floor.breakdown
            let source = floor.feeSource?.value1?.rawValue ?? floor.feeSource?.value2
            let adjusted = source == Components.Schemas.KnownFeeEstimateSource.actualFees.rawValue
            return Floor(
                marketplace: floor.marketplace.id,
                name: Formatting.marketplaceName(floor.marketplace.id),
                cents: floor.floorPrice.amountCents,
                price: Formatting.money(floor.floorPrice),
                breakdown: [
                    .init(label: "Cost", amount: Formatting.money(breakdown.cost)),
                    .init(label: "Estimated fees", amount: Formatting.money(breakdown.estimatedFees)),
                    .init(label: "Shipping", amount: Formatting.money(breakdown.shipping)),
                    .init(label: "Minimum profit", amount: Formatting.money(breakdown.minimumProfit)),
                ],
                feeNote: adjusted
                    ? "Fees from \(floor.feeTableVersion), adjusted to your recent sales"
                    : "Fees from \(floor.feeTableVersion)",
            )
        }
        tiers = suggestion.tiers.map {
            Tier(tier: $0.tier, label: $0.label, cents: $0.price.amountCents, price: Formatting.money($0.price))
        }
        estimate = suggestion.aiEstimate.map {
            Estimate(
                label: $0.label,
                range: "\(Formatting.money($0.low)) to \(Formatting.money($0.high))",
                confidence: Formatting.confidence($0.confidence),
            )
        }
        noSoldDataMessage = suggestion.noSoldDataMessage
        // Sold data bound to one marketplace (Depop Pricing Inspiration) may be shown only in that
        // marketplace's listing context, which this screen is not.
        soldData = (suggestion.soldComparables ?? []).filter { $0.marketplace == nil }.map {
            SoldData(
                label: $0.label,
                summary: "\($0.sampleSize) sold, \(Formatting.money($0.low)) to \(Formatting.money($0.high)), " +
                    "median \(Formatting.money($0.median))",
            )
        }
        researchLinks = suggestion.researchLinks.compactMap { link in
            URL(string: link.url).map { ResearchLink(label: link.label, url: $0) }
        }
    }

    /// The highest "Don't sell below" price: no listing should go under it.
    var highestFloor: Floor? {
        floors.max { $0.cents < $1.cents }
    }

    /// The tier to preselect: recommended when there is one.
    var defaultTier: Tier? {
        tiers.first { $0.tier == .recommended } ?? tiers.first
    }

    /// A warning when `cents` is below a marketplace's floor, naming them.
    func warning(for cents: Int64) -> String? {
        let below = floors.filter { cents < $0.cents }
        guard !below.isEmpty else { return nil }
        let names = below.map(\.name).formatted(.list(type: .and))
        return "Below your floor on \(names), so you would make less than your minimum after fees."
    }
}
