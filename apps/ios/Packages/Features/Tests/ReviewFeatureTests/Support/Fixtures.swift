import Foundation
import ListoraAPI

typealias Schemas = Components.Schemas

/// Contract values for the review tests, built the way the server answers.
enum Fixtures {
    static let itemID = "0196d6f0-0000-7000-8000-000000000001"
    static let fastID = "0196d6f0-0000-7000-8000-0000000000f1"
    static let premiumID = "0196d6f0-0000-7000-8000-0000000000f2"
    static let date = Date(timeIntervalSince1970: 1_800_000_000)

    static func usd(_ cents: Int64) -> Schemas.Money {
        .init(amountCents: cents, currency: .usd)
    }

    static func provenance(_ source: Schemas.KnownAnalysisProvenance) -> Schemas.AnalysisProvenance {
        .init(value1: source, value2: source.rawValue)
    }

    static func text(_ value: String, _ confidence: Double, _ source: Schemas.KnownAnalysisProvenance = .ai)
        -> Schemas.AnalyzedText
    {
        .init(value: value, confidence: confidence, provenance: provenance(source))
    }

    static func list(_ values: [String], _ confidence: Double, _ source: Schemas.KnownAnalysisProvenance = .ai)
        -> Schemas.AnalyzedTextList
    {
        .init(values: values, confidence: confidence, provenance: provenance(source))
    }

    /// A flannel shirt whose brand is a guess, whose size came from the tag, and whose UPC came
    /// from a barcode.
    static func result(needsEscalation: Bool = true) -> Schemas.AnalysisResult {
        .init(
            details: .init(
                title: text("Acme Outfitters flannel shirt, men's M", 0.82),
                description: text("Soft cotton flannel in red plaid.", 0.8),
                brand: text("Acme Outfitters", 0.45, .ocr),
                upc: text("036000291452", 0.97, .barcode),
                category: text("clothing/tops/shirts", 0.9),
                sizeLabel: text("M", 0.95, .ocr),
                sizeSystem: text("letter", 0.95, .ocr),
                colors: list(["red", "black"], 0.55),
                pattern: text("plaid", 0.88),
                materials: list(["cotton", "polyester"], 0.9, .ocr),
                condition: .init(value: .preOwnedGood, confidence: 0.7, provenance: provenance(.ai)),
            ),
            variants: [
                .init(
                    marketplace: .init(value1: .ebay, value2: "ebay"),
                    title: "Acme Outfitters Flannel Shirt Mens M Red Plaid",
                    description: "Soft flannel.",
                ),
                .init(
                    marketplace: .init(value1: .depop, value2: "depop"),
                    title: "Red plaid flannel",
                    description: "Cozy flannel.",
                    hashtags: ["flannel", "plaid"],
                ),
            ],
            priceEstimate: .init(
                label: "AI estimate - not based on sold listings",
                low: usd(1800),
                mid: usd(2600),
                high: usd(3800),
                confidence: 0.55,
            ),
            needsEscalation: needsEscalation,
            escalationReason: needsEscalation ? "The brand is uncertain." : nil,
        )
    }

    static func analysis(
        id: String = fastID,
        tier: Schemas.AnalysisTier = .fast,
        status: Schemas.AnalysisStatus,
        result: Schemas.AnalysisResult? = nil,
        failure: Schemas.AnalysisFailure? = nil,
        escalatedFrom: String? = nil,
        escalation: String? = nil,
    ) -> Schemas.Analysis {
        .init(
            id: id,
            itemId: itemID,
            photoSetHash: String(repeating: "a", count: 64),
            tier: tier,
            status: status,
            result: result,
            failure: failure,
            escalatedFromAnalysisId: escalatedFrom,
            escalationAnalysisId: escalation,
            createdAt: date,
        )
    }

    static func photo(_ index: Int, status: Schemas.PhotoStatus, failureReason: String? = nil) -> Schemas.Photo {
        .init(
            id: "0196d6f0-0000-7000-8000-00000000010\(index)",
            itemId: itemID,
            position: Int32(index),
            role: index == 0 ? .front : .tag,
            status: status,
            width: 1600,
            height: 1200,
            sha256: String(repeating: "\(index)", count: 64),
            failureReason: failureReason,
            ocrLines: [],
            barcodes: [],
            createdAt: date,
        )
    }

    /// The item as `applyAnalysis` leaves it after ``result(needsEscalation:)``: its details, each
    /// with the analysis's provenance.
    static func appliedItem(version: Int64 = 3, acceptedAnalysisID: String = fastID) -> Schemas.Item {
        var details = Schemas.ItemDetails()
        details.title = "Acme Outfitters flannel shirt, men's M"
        details.description = "Soft cotton flannel in red plaid."
        details.brand = "Acme Outfitters"
        details.category = "clothing/tops/shirts"
        details.sizeLabel = "M"
        details.sizeSystem = "letter"
        details.colors = ["red", "black"]
        details.pattern = "plaid"
        details.materials = ["cotton", "polyester"]
        details.condition = .preOwnedGood
        details.upc = "036000291452"
        details.acceptedAnalysisId = acceptedAnalysisID
        let sources: [String: String] = [
            "title": "ai", "description": "ai", "brand": "ocr", "category": "ai", "sizeLabel": "ocr",
            "sizeSystem": "ocr", "colors": "ai", "pattern": "ai", "materials": "ocr", "condition": "ai",
            "upc": "barcode",
        ]
        return item(version: version, details: details, provenance: sources.mapValues { .init(value2: $0) })
    }

    static func item(
        version: Int64 = 2,
        status: Schemas.KnownItemStatus = .draft,
        details: Schemas.ItemDetails = .init(),
        provenance: [String: Schemas.Provenance] = [:],
        photos: [Schemas.Photo] = [photo(0, status: .ready), photo(1, status: .ready)],
    ) -> Schemas.Item {
        .init(
            id: itemID,
            sku: "AJ-000184",
            status: .init(value1: status, value2: status.rawValue),
            version: version,
            details: details,
            fieldProvenance: .init(additionalProperties: provenance),
            photos: photos,
            listings: [],
            createdAt: date,
            updatedAt: date,
        )
    }

    static func floor(_ marketplace: Schemas.KnownMarketplace, _ cents: Int64) -> Schemas.MarketplaceFloor {
        .init(
            marketplace: .init(value1: marketplace, value2: marketplace.rawValue),
            floorPrice: usd(cents),
            breakdown: .init(
                cost: usd(1200),
                estimatedFees: usd(cents - 1200),
                shipping: usd(0),
                minimumProfit: usd(0),
            ),
            feeTableVersion: "\(marketplace.rawValue)-2026-10",
            feeSource: .init(value1: .feeTable, value2: "fee_table"),
        )
    }

    static func tier(_ name: Schemas.PriceTierName, _ cents: Int64, label: String) -> Schemas.PriceTier {
        .init(tier: name, price: usd(cents), basis: .init(value1: .aiEstimate, value2: "ai_estimate"), label: label)
    }

    /// Pricing with no sold data: the AI estimate's tiers and a floor per marketplace.
    static func pricing(
        floors: [Schemas.MarketplaceFloor] = [floor(.ebay, 1611), floor(.depop, 1497)],
        soldComparables: [Schemas.SoldComparables]? = nil,
    ) -> Schemas.PricingSuggestion {
        .init(
            itemId: itemID,
            soldComparables: soldComparables,
            noSoldDataMessage: soldComparables == nil ? "No sold data available for this item" : nil,
            aiEstimate: .init(
                label: "AI estimate - not based on sold listings",
                low: usd(1800),
                mid: usd(2600),
                high: usd(3800),
                confidence: 0.55,
            ),
            tiers: [
                tier(.quickSale, 1800, label: "Quick sale (AI estimate)"),
                tier(.recommended, 2600, label: "Recommended (AI estimate)"),
                tier(.higherProfit, 3800, label: "Higher profit (AI estimate)"),
            ],
            floors: floors,
            researchLinks: [
                .init(label: "Search eBay sold listings", url: "https://www.ebay.com/sch/i.html?_nkw=acme+flannel"),
            ],
            generatedAt: date,
        )
    }

    static func usage(premiumUsed: Int32, limit: Int32?) -> Schemas.Usage {
        .init(
            periodStart: "2026-10-01",
            periodEnd: "2026-11-01",
            quotas: [
                .init(metric: .init(value1: .aiItems, value2: "ai_items"), used: 4),
                .init(
                    metric: .init(value1: .premiumIdentifications, value2: "premium_identifications"),
                    used: premiumUsed,
                    limit: limit,
                ),
            ],
        )
    }
}
