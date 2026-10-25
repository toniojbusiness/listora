import Foundation
import ListoraAPI
@testable import InventoryFeature

typealias Schemas = Components.Schemas

/// Contract values for the inventory tests, built the way the server answers.
enum Fixtures {
    static let itemID = "0199f0b4-0000-7000-8000-0000000000b1"
    static let listingID = "0199f0b4-0000-7000-8000-0000000000c1"
    static let operationID = "0199f0b4-0000-7000-8000-0000000000d1"
    static let analysisID = "0199f0b4-0000-7000-8000-0000000000e1"
    static let date = Date(timeIntervalSince1970: 1_800_000_000)

    static func usd(_ cents: Int64) -> Schemas.Money {
        .init(amountCents: cents, currency: .usd)
    }

    static func marketplace(_ known: Schemas.KnownMarketplace) -> Schemas.Marketplace {
        .init(value1: known, value2: known.rawValue)
    }

    static func display(_ label: String, _ tone: Schemas.KnownStatusTone, detail: String? = nil) -> Schemas
        .StatusDisplay
    {
        .init(tone: .init(value1: tone, value2: tone.rawValue), label: label, detail: detail)
    }

    static func operation(
        kind: Schemas.KnownOperationKind = .end,
        status: Schemas.KnownOperationStatus,
        label: String,
        tone: Schemas.KnownStatusTone,
        retryable: Bool = true,
    ) -> Schemas.Operation {
        .init(
            id: operationID,
            listingId: listingID,
            itemId: itemID,
            marketplace: marketplace(.ebay),
            kind: .init(value1: kind, value2: kind.rawValue),
            status: .init(value1: status, value2: status.rawValue),
            statusDisplay: display(label, tone),
            attempt: 1,
            maxAttempts: 7,
            origin: .init(_type: .init(value1: .user, value2: "user")),
            error: status == .failed ? .init(code: "ebay_37", message: "eBay refused it.", retryable: retryable) : nil,
            createdAt: date,
            updatedAt: date,
        )
    }

    static func listing(
        status: Schemas.KnownListingStatus = .active,
        label: String = "Active (confirmed by eBay)",
        tone: Schemas.KnownStatusTone = .success,
        actions: [Schemas.KnownListingAction] = [.changePrice, .revise, .end, .verify],
        latest: Schemas.Operation? = nil,
        variant: Schemas.ListingVariant? = .init(title: "Levi's jacket", description: "Blue.", price: usd(3900)),
    ) -> Schemas.Listing {
        .init(
            id: listingID,
            itemId: itemID,
            marketplace: marketplace(.ebay),
            mode: .init(value1: .api, value2: "api"),
            status: .init(value1: status, value2: status.rawValue),
            statusDisplay: display(label, tone),
            variant: variant,
            latestOperation: latest,
            availableActions: actions.map {
                .init(action: .init(value1: $0, value2: $0.rawValue), mode: .init(value1: .api, value2: "api"))
            },
            createdAt: date,
            updatedAt: date,
        )
    }

    static func item(listings: [Schemas.Listing] = [], acceptedAnalysis: Bool = false) -> Schemas.Item {
        .init(
            id: itemID,
            sku: "AJ-000184",
            status: .init(value1: .ready, value2: "ready"),
            version: 3,
            details: .init(
                title: "Levi's Trucker Denim Jacket",
                description: "Classic trucker jacket.",
                brand: "Levi's",
                condition: .preOwnedExcellent,
                listPrice: usd(4500),
                cost: usd(800),
                acceptedAnalysisId: acceptedAnalysis ? analysisID : nil,
            ),
            photos: [],
            listings: listings,
            createdAt: date,
            updatedAt: date,
        )
    }

    static func summary(id: String, sku: String, brand: String? = nil) -> Schemas.ItemSummary {
        .init(
            id: id,
            sku: sku,
            status: .init(value1: .ready, value2: "ready"),
            title: "Item \(sku)",
            brand: brand,
            listings: [],
            createdAt: date,
            updatedAt: date,
        )
    }

    /// A connection as the server sends it (decoded, like the Marketplaces tests build them).
    static func connection(
        _ known: Schemas.KnownMarketplace,
        mode: String,
        status: String = "connected",
    ) -> Schemas.Connection {
        let object: [String: Any] = [
            "marketplace": known.rawValue,
            "mode": mode,
            "status": status,
            "statusDisplay": ["tone": "success", "label": "Connected"],
            "availableActions": [],
            "capabilities": [
                "connect": mode == "api" ? "oauth" : "none", "create": mode, "updatePrice": mode,
                "updateDetails": mode, "delist": mode, "relist": mode, "markSold": mode,
                "verifyRead": mode == "api" ? "api" : "user_confirm", "importListings": "none",
                "saleDetection": ["manual"], "imageTransport": "url_fetch",
            ],
        ]
        // swiftlint:disable:next force_try
        return try! JSONDecoder().decode(Schemas.Connection.self, from: JSONSerialization.data(withJSONObject: object))
    }
}
