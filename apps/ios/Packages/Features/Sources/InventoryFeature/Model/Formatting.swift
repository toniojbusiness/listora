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
    /// "Ready to list", "Sold, delisting"; an unknown status shows as sent.
    var label: String {
        switch value1 {
        case .draft: "Draft"
        case .ready: "Ready to list"
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
