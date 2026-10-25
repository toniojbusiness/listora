import Foundation
import ListoraAPI

/// How amounts and marketplaces read on the inventory and item screens.
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

    /// Cents for a typed dollar amount ("12", "12.5", "$12.50"); nil for anything else.
    static func cents(from text: String) -> Int64? {
        var cleaned = text.trimmingCharacters(in: .whitespaces)
        cleaned = cleaned.replacingOccurrences(of: "$", with: "")
        cleaned = cleaned.replacingOccurrences(of: ",", with: "")
        guard let match = cleaned.wholeMatch(of: /(\d{1,5})(?:\.(\d{1,2}))?/) else { return nil }
        let whole = Int64(match.output.1) ?? 0
        var fraction: Int64 = 0
        if let digits = match.output.2 {
            let padded = digits.count == 1 ? "\(digits)0" : String(digits)
            fraction = Int64(padded) ?? 0
        }
        return whole * 100 + fraction
    }

    /// "12.50" (no currency sign), for an editable amount field.
    static func editableAmount(cents: Int64) -> String {
        let fraction = cents % 100
        return fraction == 0 ? "\(cents / 100)" : String(format: "%lld.%02lld", cents / 100, fraction)
    }

    /// "Oct 24, 3:05 PM".
    static func timestamp(_ date: Date) -> String {
        date.formatted(date: .abbreviated, time: .shortened)
    }
}

extension Components.Schemas.Marketplace {
    /// The raw id, known or not.
    var id: String {
        value1?.rawValue ?? value2 ?? ""
    }
}

extension Components.Schemas.ItemStatus {
    /// "Ready", "Sold, delisting"; an unknown status shows as sent.
    var label: String {
        switch value1 {
        case .draft: "Draft"
        case .ready: "Ready"
        case .listed: "Listed"
        case .soldPendingDelist: "Sold, delisting"
        case .sold: "Sold"
        case .shipped: "Shipped"
        case .archived: "Archived"
        case nil: value2 ?? ""
        }
    }
}

extension Components.Schemas.KnownItemStatus {
    var label: String {
        Components.Schemas.ItemStatus(value1: self).label
    }
}
