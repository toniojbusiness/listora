import DesignSystem
import Foundation
import ListoraAPI

/// How amounts, marketplaces, statuses, and fees read on the sales screens.
enum SaleFormatting {
    /// "$12.50" for 1250 cents of USD.
    static func money(_ money: Money) -> String {
        Self.money(cents: money.amountCents, currency: money.currency.rawValue)
    }

    static func money(cents: Int64, currency: String = "USD") -> String {
        (Decimal(cents) / 100).formatted(.currency(code: currency))
    }

    /// "+125.5%" for 12550 basis points; a loss reads "-12%".
    static func roi(basisPoints: Int64) -> String {
        let percent = Decimal(basisPoints) / 100
        let text = percent.formatted(.number.precision(.fractionLength(0 ... 1)))
        return basisPoints > 0 ? "+\(text)%" : "\(text)%"
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

    /// "Oct 24, 2026".
    static func day(_ date: Date) -> String {
        date.formatted(date: .abbreviated, time: .omitted)
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

    var name: String {
        SaleFormatting.marketplaceName(id)
    }
}

extension KnownMarketplace {
    var name: String {
        SaleFormatting.marketplaceName(rawValue)
    }
}

extension Components.Schemas.SaleStatus {
    /// "New", "Shipped"; an unknown status shows as sent.
    var label: String {
        switch value1 {
        case .detected: "New"
        case .confirmed: "Confirmed"
        case .shipped: "Shipped"
        case .canceled: "Canceled"
        case .returned: "Returned"
        case nil: value2 ?? ""
        }
    }

    var tone: StatusTone {
        switch value1 {
        case .detected: .inProgress
        case .confirmed, .shipped: .success
        case .canceled, .returned: .neutral
        case nil: .neutral
        }
    }

    /// The sale no longer stands.
    var isUndone: Bool {
        value1 == .canceled || value1 == .returned
    }
}

extension Components.Schemas.FeeType {
    /// "Marketplace fee"; an unknown type reads like `other`.
    var label: String {
        switch value1 {
        case .marketplace: "Marketplace fee"
        case .payment: "Payment processing"
        case .shippingLabel: "Shipping label"
        case .promotion: "Promotion"
        case .tax: "Tax"
        case .other, nil: "Other fee"
        }
    }
}

extension StatusTone {
    init(_ tone: Components.Schemas.StatusTone) {
        switch tone.value1 {
        case .success: self = .success
        case .inProgress: self = .inProgress
        case .checking: self = .checking
        case .failed: self = .failed
        case .actionNeeded: self = .actionNeeded
        case .neutral, nil: self = .neutral
        }
    }
}

extension Sale {
    /// "Levi's Trucker Denim Jacket", or "Levi's Trucker Denim Jacket + 1 more" for a bundle.
    var title: String {
        let first = items.first.map { $0.title ?? $0.sku } ?? "Sale"
        return items.count > 1 ? "\(first) + \(items.count - 1) more" : first
    }

    /// The actions the server allows, in its order; unknown ones are hidden.
    var knownActions: [Components.Schemas.KnownSaleAction] {
        availableActions.compactMap(\.value1)
    }

    /// The items whose relist question is still open.
    var pendingRelists: [SaleItem] {
        items.filter { $0.relist?.decision.value1 == .pending }
    }
}
