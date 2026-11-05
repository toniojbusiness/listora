import Foundation

/// The scan's answer with eBay's comparison read: what close matches sold for, the call resting
/// on them, and eBay's sold pace.
func ebaySoldScanJSON(id: String) -> [String: Any] {
    var scan = itemScanJSON(id: id, call: "buy", basis: "market_sold")
    let pace = "Sold listings on eBay: 410 in the last 90 days; 320 for sale now"
    scan["comparisons"] = [[
        "marketplace": "ebay", "status": "read",
        "label": "eBay: sold $18-$30, 9 like it in the last 14 days",
        "asking": [
            "count": 4, "low": usd(2500), "median": usd(2900), "high": usd(3500),
            "label": "Asking prices - not sold listings",
        ],
        "sold": [
            "count": 9, "low": usd(1800), "median": usd(2400), "high": usd(3000), "windowDays": 14,
            "label": "Sold listings on eBay",
        ],
        "supply": 320,
        "demand": ["demand": "strong", "label": "Sells fast on eBay", "basedOn": pace],
    ]]
    var call = scan["call"] as? [String: Any] ?? [:]
    call["basedOn"] = "Sold listings on eBay: 9 like it in the last 14 days"
    call["signals"] = [["kind": "demand", "label": "Sells fast on eBay", "basedOn": pace]]
    scan["call"] = call
    return scan
}

/// The scan's answer with Mercari's comparison read: what close matches sold for, and how many
/// of Mercari's latest sales were in the last 30 days.
func mercariSoldScanJSON(id: String) -> [String: Any] {
    var scan = itemScanJSON(id: id, call: "buy", basis: "market_sold")
    let pace = "Sold listings on Mercari: 24 of the latest 30 sold in the last 30 days"
    scan["comparisons"] = [[
        "marketplace": "mercari", "status": "read",
        "label": "Mercari: sold $20-$28, 7 like it in the last 21 days",
        "sold": [
            "count": 7, "low": usd(2000), "median": usd(2400), "high": usd(2800), "windowDays": 21,
            "label": "Sold listings on Mercari",
        ],
        "supply": 1400,
        "demand": ["demand": "strong", "label": "Sells fast on Mercari", "basedOn": pace],
    ]]
    var call = scan["call"] as? [String: Any] ?? [:]
    call["basedOn"] = "Sold listings on Mercari: 7 like it in the last 21 days"
    call["signals"] = [["kind": "demand", "label": "Sells fast on Mercari", "basedOn": pace]]
    scan["call"] = call
    return scan
}

/// The scan's answer with Poshmark's comparison read: what close matches sold for lately, the
/// call resting on them, and Poshmark's recent sold pace by the days they sold.
func poshmarkSoldScanJSON(id: String) -> [String: Any] {
    var scan = itemScanJSON(id: id, call: "buy", basis: "market_sold")
    let pace = "Sold listings on Poshmark: 44 like it in the last 42 days; 97,581 for sale now"
    scan["comparisons"] = [[
        "marketplace": "poshmark", "status": "read",
        "label": "Poshmark: sold $18-$34, 44 like it in the last 42 days",
        "asking": [
            "count": 41, "low": usd(2300), "median": usd(3000), "high": usd(4000),
            "label": "Asking prices - not sold listings",
        ],
        "sold": [
            "count": 44, "low": usd(1800), "median": usd(2350), "high": usd(3400), "windowDays": 42,
            "label": "Sold listings on Poshmark",
        ],
        "supply": 97581,
        "demand": ["demand": "strong", "label": "Sells fast on Poshmark", "basedOn": pace],
    ]]
    var call = scan["call"] as? [String: Any] ?? [:]
    call["basedOn"] = "Sold listings on Poshmark: 44 like it in the last 42 days"
    call["signals"] = [["kind": "demand", "label": "Sells fast on Poshmark", "basedOn": pace]]
    scan["call"] = call
    return scan
}

/// The scan's answer with Vinted's comparison read: Vinted shows a visitor no sold listings, so
/// its row is close matches' asking prices under their label, and the demand the household's own
/// sales against Vinted's supply.
func vintedAskingScanJSON(id: String) -> [String: Any] {
    var scan = itemScanJSON(id: id, call: "your_call", basis: "ai_estimate")
    let demand = "Your 0 sales like it in the last 90 days; 500 for sale on Vinted now"
    scan["comparisons"] = [[
        "marketplace": "vinted", "status": "read",
        "label": "Vinted: asking $25-$30, 5 like it for sale",
        "asking": [
            "count": 5, "low": usd(2500), "median": usd(2800), "high": usd(3000),
            "label": "Asking prices - not sold listings",
        ],
        "supply": 500,
        "demand": ["demand": "crowded", "label": "Crowded on Vinted", "basedOn": demand],
    ]]
    return scan
}

private func usd(_ cents: Int) -> [String: Any] {
    ["amountCents": cents, "currency": "USD"]
}
