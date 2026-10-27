import Foundation
import ListoraAPI

typealias Money = Components.Schemas.Money

/// How amounts, marketplaces, and confidences read on the review and price screens.
enum Formatting {
    /// "$12.50" for 1250 cents of USD.
    static func money(_ money: Money) -> String {
        Self.money(cents: money.amountCents, currency: money.currency.rawValue)
    }

    static func money(cents: Int64, currency: String = "USD") -> String {
        (Decimal(cents) / 100).formatted(.currency(code: currency))
    }

    /// The marketplace's own spelling; an id this app does not know shows as sent.
    static func marketplaceName(_ id: String) -> String {
        switch id {
        case "ebay": "eBay"
        case "depop": "Depop"
        case "poshmark": "Poshmark"
        case "mercari": "Mercari"
        default: id
        }
    }

    /// "Confidence 55%" for 0.55.
    static func confidence(_ value: Double) -> String {
        "Confidence \(Int((min(max(value, 0), 1) * 100).rounded()))%"
    }
}

extension Components.Schemas.Marketplace {
    /// The raw id, known or not.
    var id: String {
        value1?.rawValue ?? value2 ?? ""
    }
}

extension Components.Schemas.PrefillFieldKey {
    /// The raw key, known or not.
    var id: String {
        value1?.rawValue ?? value2 ?? ""
    }
}
