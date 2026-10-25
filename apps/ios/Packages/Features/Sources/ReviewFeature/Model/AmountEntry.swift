import Foundation

/// A dollar amount typed on the in-app keypad: digits, at most one decimal point, and at most two
/// digits after it. Keys that would make an invalid amount are ignored, so the entry is always a
/// valid amount (or empty). Amounts are integer cents, never floating point.
struct AmountEntry: Equatable, Sendable {
    enum Key: Hashable, Sendable {
        case digit(Int)
        case decimalPoint
        case delete
    }

    /// $99,999.99 is plenty for one resale item.
    static let maxWholeDigits = 5

    private(set) var text = ""

    init() {}

    /// The entry showing `cents`, for editing an amount the item already has.
    init(cents: Int64) {
        let whole = cents / 100
        let fraction = cents % 100
        text = fraction == 0 ? "\(whole)" : String(format: "%lld.%02lld", whole, fraction)
    }

    mutating func press(_ key: Key) {
        switch key {
        case let .digit(digit):
            guard (0 ... 9).contains(digit) else { return }
            let parts = text.split(separator: ".", omittingEmptySubsequences: false)
            if parts.count == 2 {
                guard parts[1].count < 2 else { return }
            } else {
                guard text.count < Self.maxWholeDigits else { return }
                // No leading zeros: "0" then "5" is "5".
                if text == "0" {
                    text = ""
                }
            }
            text.append(String(digit))
        case .decimalPoint:
            guard !text.contains(".") else { return }
            text = text.isEmpty ? "0." : text + "."
        case .delete:
            if !text.isEmpty {
                text.removeLast()
            }
        }
    }

    var isEmpty: Bool {
        text.isEmpty
    }

    /// The amount in cents; nil while empty.
    var cents: Int64? {
        guard !text.isEmpty else { return nil }
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        let whole = Int64(parts[0]) ?? 0
        var fraction: Int64 = 0
        if parts.count == 2 {
            let digits = String(parts[1]).padding(toLength: 2, withPad: "0", startingAt: 0)
            fraction = Int64(digits) ?? 0
        }
        return whole * 100 + fraction
    }

    /// The keys pressed, with a dollar sign ("$12.5" while typing $12.50).
    var display: String {
        text.isEmpty ? "$0" : "$" + text
    }
}
