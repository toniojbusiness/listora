import Foundation

// Invented scans; no real shop's data.

/// The scan's answer while its prices wait for the web research: what it is, no price.
func heldScanJSON(id: String, waitingOn: [String] = ["web"]) -> [String: Any] {
    var scan = itemScanJSON(id: id)
    scan.removeValue(forKey: "aiEstimate")
    scan["ownSales"] = [Any]()
    scan["identity"] = [
        "item": "black high-rise leggings", "brand": "Lululemon", "sizeLabel": "6", "material": "nylon",
        "era": "vintage 1990s", "condition": "pre_owned_good", "confidence": 0.9,
    ]
    let label = "Checking prices: " + waitingOn.map { $0 == "web" ? "the web" : $0.capitalized }
        .joined(separator: ", ")
    scan["call"] = [
        "call": "checking", "label": "Checking prices", "confidence": "high", "basis": "none",
        "basedOn": label, "worthListing": dollars(800), "signals": [Any](),
    ]
    scan["pricing"] = ["status": "checking", "label": label, "waitingOn": waitingOn]
    return scan
}

/// The scan's answer once its prices are in: the verdict, its why, and the reality check.
func pricedScanJSON(id: String, call: String = "your_call", missing: [String] = []) -> [String: Any] {
    var scan = itemScanJSON(id: id, call: call)
    var details = scan["call"] as? [String: Any] ?? [:]
    details["why"] = "Pays out $22-$26 after fees, but often faked: check it's real"
    details["prices"] = [
        "listAt": dollars(3500), "realisticSale": dollars(2800), "fastSale": dollars(2500),
        "basedOn": "Likely sale is the middle of your sales like it, fast sale its low end",
    ]
    scan["call"] = details
    scan["pricing"] = [
        "status": "ready",
        "label": "Checked your sales and the web.",
        "missing": missing.map { ["source": "web", "label": $0] },
    ]
    scan["realityCheck"] = [
        ["kind": "own_sales", "text": "You sold 3 like it on Depop: $25-$29, most around $28"],
        ["kind": "retail", "text": "Retail about $98 (lululemon.com)"],
    ] + missing.map { ["kind": "missing", "text": $0] }
    return scan
}

private func dollars(_ cents: Int) -> [String: Any] {
    ["amountCents": cents, "currency": "USD"]
}
