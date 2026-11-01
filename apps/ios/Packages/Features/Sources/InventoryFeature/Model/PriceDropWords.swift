import Foundation
import ListoraAPI

/// How smart price drops read in the app (docs/features/price-drops.md): a rule's terms, what it
/// is for, a planned drop, and what a default rests on.
enum PriceDropWords {
    /// "10% off after 21 days unsold, never below $25.00".
    static func terms(percent: Int, afterDays: Int, floor: Money) -> String {
        "\(percent)% off after \(days(afterDays)) unsold, never below \(Formatting.money(floor))"
    }

    static func terms(_ rule: Components.Schemas.PriceDropRule) -> String {
        terms(percent: Int(rule.percent), afterDays: Int(rule.afterDays), floor: rule.floor)
    }

    /// "Patagonia", or "This item (AJ-000184)"; a scope this build doesn't know shows its name.
    static func target(_ rule: Components.Schemas.PriceDropRule) -> String {
        switch rule.scope.value1 {
        case .brand: rule.brand ?? "A brand"
        case .item: rule.title ?? rule.sku ?? "One item"
        case nil: rule.scope.value2 ?? ""
        }
    }

    /// "Every Patagonia item", "This item only".
    static func scopeLine(_ rule: Components.Schemas.PriceDropRule) -> String {
        switch rule.scope.value1 {
        case .brand:
            let count = rule.liveListings
            let live = count == 1 ? "1 live listing" : "\(count) live listings"
            return "Every \(rule.brand ?? "brand") item without its own rule · \(live)"
        case .item: return "This item only, over its brand's rule"
        case nil: return ""
        }
    }

    /// "Drops from $40.00 to $36.00, Tue, 3:00 PM", "At its lowest price", or why it won't drop.
    static func plan(_ drop: Components.Schemas.PlannedPriceDrop, now: Date = Date()) -> String {
        switch drop.state.value1 {
        case .scheduled:
            let next = drop.nextPrice.map(Formatting.money) ?? ""
            let when = drop.at.map { $0 <= now ? "soon" : moment($0, now: now) } ?? "soon"
            return "Drops from \(Formatting.money(drop.price)) to \(next), \(when)"
        case .atFloor: return "At its lowest price, \(Formatting.money(drop.price))"
        case .lastFailed: return "Paused: its last price change failed. Retry it on the item."
        case .unavailable: return "Listora can't change this price here."
        case nil: return drop.state.value2 ?? ""
        }
    }

    /// "Half your Patagonia items sold within 18 days (7 sales)", or the fallback's reason.
    static func basis(_ defaults: Components.Schemas.PriceDropDefaults) -> String {
        guard let basis = defaults.basis else {
            return "Not enough of your sales yet to go by, so this starts at 21 days."
        }
        let sales = basis.sales == 1 ? "1 sale" : "\(basis.sales) sales"
        let what = basis.brand.map { "your \($0) items" } ?? "your items"
        return "Half \(what) sold within \(days(Int(basis.medianDays))) (\(sales) this year)."
    }

    /// "1 day", "21 days".
    static func days(_ days: Int) -> String {
        days == 1 ? "1 day" : "\(days) days"
    }

    /// "today, 3:00 PM", "Tue, 3:00 PM", or "Nov 12, 3:00 PM".
    static func moment(_ date: Date, now: Date) -> String {
        let calendar = Calendar.current
        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDate(date, inSameDayAs: now) {
            return "today, \(time)"
        }
        if let week = calendar.date(byAdding: .day, value: 6, to: now), date < week {
            return "\(date.formatted(.dateTime.weekday(.abbreviated))), \(time)"
        }
        return "\(date.formatted(.dateTime.month(.abbreviated).day())), \(time)"
    }
}
