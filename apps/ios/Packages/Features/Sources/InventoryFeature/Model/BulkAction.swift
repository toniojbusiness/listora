import Foundation
import ListoraAPI

/// One change for many items at once, from Inventory's selection, or for every marketplace of one
/// item (the item screen's List everywhere).
enum BulkAction: Equatable, Sendable {
    /// List each item on these marketplaces (ids), where it is not listed yet.
    case list(marketplaces: Set<String>)
    /// End every live listing of each item.
    case end(EndReason)
    /// Relist every ended listing of each item.
    case relist
    /// Change the price of every live listing, and the item's list price, by the same rule.
    case changePrice(PriceAdjustment)
    /// Delete each item from Listora (only an item on no marketplace can be deleted).
    case delete
}

/// What Change price does to each price: lower or raise it by a percentage or an amount.
struct PriceAdjustment: Equatable, Sendable {
    enum Direction: String, CaseIterable, Sendable {
        case lower
        case raise
    }

    enum Unit: String, CaseIterable, Sendable {
        case percent
        case amount
    }

    var direction = Direction.lower
    var unit = Unit.percent
    /// Whole percent, or cents.
    var value = 10

    /// The new price in cents, rounded to the cent; nil when it would not be above $0, or when
    /// there is nothing to change.
    func apply(to cents: Int64) -> Int64? {
        guard value > 0 else { return nil }
        let change: Int64 = switch unit {
        case .percent: (cents * Int64(value) + 50) / 100
        case .amount: Int64(value)
        }
        let new = direction == .lower ? cents - change : cents + change
        return new > 0 ? new : nil
    }

    /// "10% lower", "$5.00 higher".
    var summary: String {
        let amount = unit == .percent ? "\(value)%" : Formatting.money(cents: Int64(value))
        return "\(amount) \(direction == .lower ? "lower" : "higher")"
    }
}

/// How one change went for one item on one marketplace (or for the item itself), in words the
/// seller reads. Started is not done: the item shows each listing's progress until the
/// marketplace confirms it.
struct BulkOutcome: Identifiable, Equatable, Sendable {
    enum Result: Equatable, Sendable {
        /// Listora took the change and is working on it ("Listing on eBay started").
        case started
        /// Done for good, confirmed by Listora's server (an item deleted, a list price saved).
        case done
        /// Nothing was sent; `message` says why and what to do.
        case skipped
        /// Listora or the marketplace refused it, or Listora couldn't be reached.
        case failed
    }

    let itemID: String
    let sku: String
    let title: String
    /// The marketplace id, or nil for the item itself.
    let marketplace: String?
    let result: Result
    let message: String

    var id: String {
        "\(itemID).\(marketplace ?? "item")"
    }
}

extension ItemSummary {
    /// The item as a list shows it, for a bulk change started from the item screen.
    init(_ item: Item) {
        self.init(
            id: item.id,
            sku: item.sku,
            status: item.status,
            title: item.details.title,
            brand: item.details.brand,
            sizeLabel: item.details.sizeLabel,
            listPrice: item.details.listPrice,
            coverPhoto: item.photos.first,
            listings: [],
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
        )
    }
}
