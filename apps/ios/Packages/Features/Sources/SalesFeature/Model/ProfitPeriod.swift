import Foundation

/// The kinds of period the profit dashboard offers.
enum ProfitRange: String, CaseIterable, Identifiable, Sendable {
    case week
    case month
    case year
    case custom

    var id: Self {
        self
    }

    var title: String {
        switch self {
        case .week: "Week"
        case .month: "Month"
        case .year: "Year"
        case .custom: "Custom"
        }
    }
}

/// The days a profit report covers, in the calendar's time zone: a whole calendar week, month,
/// or year, or a custom range. `start` and `end` are the first and last day (inclusive), each at
/// the start of its day.
struct ProfitPeriod: Equatable, Sendable {
    /// The longest custom range, in days; the server refuses longer ones.
    static let maximumDays = 3660

    let range: ProfitRange
    let start: Date
    let end: Date

    /// The period of `range` that contains `now`; a custom range starts as the last 30 days.
    static func containing(_ now: Date, range: ProfitRange, calendar: Calendar) -> ProfitPeriod {
        let today = calendar.startOfDay(for: now)
        guard let component = range.component,
              let interval = calendar.dateInterval(of: component, for: today),
              let last = calendar.date(byAdding: .day, value: -1, to: interval.end)
        else {
            let start = calendar.date(byAdding: .day, value: -29, to: today) ?? today
            return ProfitPeriod(range: .custom, start: start, end: today)
        }
        return ProfitPeriod(range: range, start: interval.start, end: calendar.startOfDay(for: last))
    }

    /// A custom period from `start` to `end`, in order and at most ``maximumDays`` long.
    static func custom(from start: Date, to end: Date, calendar: Calendar) -> ProfitPeriod {
        var first = calendar.startOfDay(for: min(start, end))
        let last = calendar.startOfDay(for: max(start, end))
        if let earliest = calendar.date(byAdding: .day, value: -(maximumDays - 1), to: last), first < earliest {
            first = earliest
        }
        return ProfitPeriod(range: .custom, start: first, end: last)
    }

    /// The same kind of period `steps` periods later (earlier for a negative count).
    func shifted(by steps: Int, calendar: Calendar) -> ProfitPeriod {
        guard let component = range.component,
              let moved = calendar.date(byAdding: component, value: steps, to: start)
        else { return self }
        return ProfitPeriod.containing(moved, range: range, calendar: calendar)
    }

    /// Whether the period reaches today or later: there is nothing after it to step to.
    func reachesToday(_ now: Date, calendar: Calendar) -> Bool {
        end >= calendar.startOfDay(for: now)
    }

    /// "October 2026", "2026", "Oct 19 – 25, 2026".
    func title(calendar: Calendar) -> String {
        switch range {
        case .month:
            start.formatted(Self.style(.dateTime.month(.wide).year(), calendar: calendar))
        case .year:
            start.formatted(Self.style(.dateTime.year(), calendar: calendar))
        case .week, .custom:
            (start ..< end).formatted(Self.intervalStyle(calendar: calendar))
        }
    }

    private static func style(_ style: Date.FormatStyle, calendar: Calendar) -> Date.FormatStyle {
        var style = style
        style.calendar = calendar
        style.timeZone = calendar.timeZone
        return style
    }

    private static func intervalStyle(calendar: Calendar) -> Date.IntervalFormatStyle {
        var style = Date.IntervalFormatStyle(date: .abbreviated, time: .omitted)
        style.calendar = calendar
        style.timeZone = calendar.timeZone
        return style
    }

    /// The report query for these days in the calendar's time zone.
    func query(calendar: Calendar) -> ProfitQuery {
        ProfitQuery(
            firstDay: Self.day(start, calendar: calendar),
            lastDay: Self.day(end, calendar: calendar),
            timeZone: calendar.timeZone.identifier,
        )
    }

    static func day(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
}

extension ProfitRange {
    fileprivate var component: Calendar.Component? {
        switch self {
        case .week: .weekOfYear
        case .month: .month
        case .year: .year
        case .custom: nil
        }
    }
}
