import Foundation
import ListoraAPI

/// How a haul reads on the cost screens: "$1.67 each, from a $50 haul of 30". The server keeps each
/// item's cost; these numbers are only shown.
enum HaulPresentation {
    /// The total over the count to the nearest cent, half up, as the server's `eachCost` is.
    static func eachCents(totalCents: Int64, count: Int) -> Int64 {
        guard count > 0 else { return 0 }
        let count = Int64(count)
        return (2 * totalCents + count) / (2 * count)
    }

    /// "$1.67 each, from a $50 haul of 30": the share always to the cent, the total in whole
    /// dollars when it is one.
    static func summary(eachCents: Int64, totalCents: Int64, count: Int) -> String {
        "\(Formatting.money(cents: eachCents)) each, from a \(money(totalCents)) haul of \(count)"
    }

    static func summary(_ haul: Haul) -> String {
        summary(eachCents: haul.eachCost.amountCents, totalCents: haul.total.amountCents, count: Int(haul.itemCount))
    }

    /// A saved haul as a choice: "$50 haul of 30, Goodwill Bins".
    static func choice(_ haul: Haul) -> String {
        let name = "\(money(haul.total.amountCents)) haul of \(haul.itemCount)"
        guard let source = haul.purchaseSource else { return name }
        return "\(name), \(source)"
    }

    /// Whole dollars without cents ("$50"), any other amount with them ("$1.67").
    static func money(_ cents: Int64) -> String {
        cents.isMultiple(of: 100)
            ? (Decimal(cents) / 100).formatted(.currency(code: "USD").precision(.fractionLength(0)))
            : Formatting.money(cents: cents)
    }
}
