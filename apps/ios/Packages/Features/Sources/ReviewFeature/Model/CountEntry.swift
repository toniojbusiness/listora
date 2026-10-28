import Foundation

/// A whole number typed on the in-app keypad (how many items a haul had): digits only, no leading
/// zero, at most ``maxDigits``. The decimal point is ignored, so the entry is always a count (or
/// empty).
struct CountEntry: Equatable, Sendable {
    /// 10,000 items, the most a haul has on the server.
    static let maxDigits = 5
    static let maximum = 10000

    private(set) var text = ""

    init() {}

    init(_ count: Int) {
        text = count > 0 ? "\(min(count, Self.maximum))" : ""
    }

    mutating func press(_ key: AmountEntry.Key) {
        switch key {
        case let .digit(digit):
            guard (0 ... 9).contains(digit), text.count < Self.maxDigits, !(text.isEmpty && digit == 0) else { return }
            let next = text + String(digit)
            guard let value = Int(next), value <= Self.maximum else { return }
            text = next
        case .decimalPoint:
            return
        case .delete:
            if !text.isEmpty {
                text.removeLast()
            }
        }
    }

    var isEmpty: Bool {
        text.isEmpty
    }

    /// The count; nil while empty.
    var value: Int? {
        Int(text)
    }
}
