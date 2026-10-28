import Foundation
import ListoraAPI

/// How listing refresh reads in the app: each cadence's name, and a listing's next and last
/// refresh (docs/features/listing-refresh.md).
enum RefreshWords {
    /// The choices, in the order the pickers show them.
    static let cadences: [Components.Schemas.KnownRefreshCadence] = [
        .every72Hours, .daily, .everyFewDays, .weekly, .custom, .off,
    ]

    /// "Every 72 hours", "Every 36 hours" for a custom one, "Off".
    static func name(_ cadence: Components.Schemas.KnownRefreshCadence, customHours: Int? = nil) -> String {
        switch cadence {
        case .every72Hours: "Every 72 hours"
        case .daily: "Daily"
        case .everyFewDays: "Every few days"
        case .weekly: "Weekly"
        case .custom: customHours.map(hours) ?? "Custom"
        case .off: "Off"
        }
    }

    /// The server's cadence, known or not (an unknown one shows as sent).
    static func name(_ cadence: Components.Schemas.RefreshCadence, customHours: Int32?) -> String {
        guard let known = cadence.value1 else { return cadence.value2 ?? "" }
        return name(known, customHours: customHours.map(Int.init))
    }

    /// "Every 36 hours", or "Every 4 days" in whole days.
    static func hours(_ hours: Int) -> String {
        if hours >= 48, hours.isMultiple(of: 24) {
            return "Every \(hours / 24) days"
        }
        return "Every \(hours) hours"
    }

    /// "Next refresh Thu, 9:00 AM · Last refreshed Oct 27", "Refresh off", or nil where Listora
    /// doesn't refresh (eBay, an assisted marketplace): the row then says nothing about it.
    static func line(_ refresh: Components.Schemas.ListingRefresh?, now: Date = Date()) -> String? {
        guard let refresh else { return nil }
        let last = refresh.lastAt.map { "Last refreshed \(day($0, now: now))" }
        switch refresh.state.value1 {
        case .scheduled:
            let next = refresh.nextAt.map { $0 <= now ? "Refreshing soon" : "Next refresh \(moment($0, now: now))" }
            return [next, last].compactMap(\.self).joined(separator: " · ")
        case .off:
            return ["Refresh off", last].compactMap(\.self).joined(separator: " · ")
        case .unavailable, nil:
            return last
        }
    }

    /// "today, 9:00 AM", "Thu, 9:00 AM", or "Nov 3, 9:00 AM".
    private static func moment(_ date: Date, now: Date) -> String {
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

    /// "today" or "Oct 27".
    private static func day(_ date: Date, now: Date) -> String {
        Calendar.current.isDate(date, inSameDayAs: now) ? "today" : date.formatted(.dateTime.month(.abbreviated).day())
    }
}
