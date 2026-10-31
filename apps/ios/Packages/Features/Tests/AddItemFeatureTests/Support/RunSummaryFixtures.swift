import Foundation
import ListoraAPI
@testable import AddItemFeature

// Invented runs, places, and prices; no real shop's data.

/// A run's summary as the server would send it: checked out by default, with the estimated
/// profit; `checkedOut: false` is the run before checkout.
func runSummaryJSON(
    checkedOut: Bool = true,
    place: String? = "Goodwill Outlet",
    miles: Int? = 8,
    keptItems: Int = 3,
    estimatedItems: Int? = 3,
    profit: (low: Int, high: Int) = (4210, 7110),
) -> [String: Any] {
    var run: [String: Any] = [
        "id": "0193a000-0000-7000-8000-000000000002",
        "startedAt": "2026-10-31T00:00:00Z",
        "scanCount": 12,
        "keptCount": keptItems,
    ]
    run["place"] = place
    var summary: [String: Any] = ["run": run, "keptItems": keptItems]
    if let estimatedItems {
        summary["estimate"] = [
            "itemCount": estimatedItems,
            "resaleLow": usd(7500), "resaleHigh": usd(11200),
            "payoutLow": usd(6210), "payoutHigh": usd(9110),
            "basedOn": "1 from your own sales, 2 from the AI estimate",
            "label": "Estimated - includes the AI estimate, not based on sold listings",
        ]
    }
    if checkedOut {
        run["endedAt"] = "2026-10-31T01:00:00Z"
        run["checkedOutAt"] = "2026-10-31T01:00:00Z"
        run["haulId"] = "0193a000-0000-7000-8000-000000000009"
        run["miles"] = miles
        summary["run"] = run
        var haul: [String: Any] = [
            "id": "0193a000-0000-7000-8000-000000000009",
            "total": usd(2000), "itemCount": 4, "itemsAdded": keptItems, "eachCost": usd(500),
            "purchaseDate": "2026-10-31",
            "createdAt": "2026-10-31T01:00:00Z", "updatedAt": "2026-10-31T01:00:00Z",
        ]
        haul["purchaseSource"] = place
        summary["haul"] = haul
        if estimatedItems != nil {
            summary["profitEstimate"] = [
                "low": usd(profit.low), "high": usd(profit.high), "label": "Estimated, after fees",
            ]
        }
    }
    return summary
}

func decodeRunSummary(_ object: [String: Any]) throws -> SourcingRunSummary {
    try decodeRunSummary(JSONSerialization.data(withJSONObject: object))
}

func decodeRunSummary(_ data: Data) throws -> SourcingRunSummary {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(SourcingRunSummary.self, from: data)
}

private func usd(_ cents: Int) -> [String: Any] {
    ["amountCents": cents, "currency": "USD"]
}
