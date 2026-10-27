import Foundation

/// How long a sale's delist everywhere else has taken so far, or took (docs/features/
/// auto-delist.md): from the moment Listora saw the sale (the delist run's start) to the last of
/// the item's other listings delisted and confirmed. The target is under a minute.
public enum DelistClock {
    /// "Sold 23 s ago · 1 of 3 delisted" while it runs, "Delisted everywhere in 41 s" once every
    /// listing is delisted or confirmed; `nil` when there was nothing to delist.
    public static func text(startedAt: Date, completedAt: Date?, done: Int, total: Int, now: Date) -> String? {
        guard total > 0 else { return nil }
        if let completedAt, done >= total {
            return "Delisted everywhere in \(duration(completedAt.timeIntervalSince(startedAt)))"
        }
        return "Sold \(duration(now.timeIntervalSince(startedAt))) ago · \(done) of \(total) delisted"
    }

    /// "41 s", "2 min 5 s", "1 h 5 min": whole seconds, never below 0.
    public static func duration(_ interval: TimeInterval) -> String {
        let seconds = max(0, Int(interval.rounded(.down)))
        if seconds < 60 {
            return "\(seconds) s"
        }
        if seconds < 3600 {
            let rest = seconds % 60
            return rest == 0 ? "\(seconds / 60) min" : "\(seconds / 60) min \(rest) s"
        }
        let minutes = (seconds % 3600) / 60
        return minutes == 0 ? "\(seconds / 3600) h" : "\(seconds / 3600) h \(minutes) min"
    }
}
