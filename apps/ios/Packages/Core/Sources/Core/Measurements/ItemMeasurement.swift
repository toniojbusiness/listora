import Foundation

/// A garment measurement the review asks for, by its canonical name in the item's
/// `measurements` (the contract's `Measurement.name`).
public enum MeasurementKind: String, CaseIterable, Hashable, Sendable {
    case pitToPit = "pit_to_pit"
    case length
    case waist
    case inseam
    case rise

    /// "Pit to pit", as the review and the listing copy name it.
    public var title: String {
        switch self {
        case .pitToPit: "Pit to pit"
        case .length: "Length"
        case .waist: "Waist"
        case .inseam: "Inseam"
        case .rise: "Rise"
        }
    }

    /// Where to measure, in a few words.
    public var hint: String {
        switch self {
        case .pitToPit: "Armpit to armpit, laid flat"
        case .length: "Top of the shoulder or waistband to the hem"
        case .waist: "Across the waistband, laid flat"
        case .inseam: "Crotch seam to the hem"
        case .rise: "Crotch seam to the top of the waistband"
        }
    }

    /// The measurements that fit an item of `category` (a vocabulary path such as
    /// `clothing/bottoms/jeans`), in the order a buyer reads them; none for what is not worn
    /// (bags, jewelry, home), for shoes, intimates, and swimwear sold by its size, and while the
    /// category is unknown.
    public static func fitting(category: String?) -> [MeasurementKind] {
        guard let category else { return [] }
        let parts = category.split(separator: "/").map(String.init)
        guard parts.first == "clothing", parts.count >= 2 else { return [] }
        let group = byCategory[parts[1]]
        return parts.count >= 3 ? group?.subcategories[parts[2]] ?? group?.kinds ?? [] : group?.kinds ?? []
    }

    private static let top: [MeasurementKind] = [.pitToPit, .length]
    private static let bottom: [MeasurementKind] = [.waist, .inseam, .rise, .length]
    private static let whole: [MeasurementKind] = [.pitToPit, .waist, .inseam, .rise, .length]

    /// Each clothing category's measurements, and its subcategories that differ.
    private static let byCategory: [String: (kinds: [MeasurementKind], subcategories: [String: [MeasurementKind]])] = [
        "tops": (top, [:]),
        "outerwear": (top, [:]),
        "bottoms": (bottom, ["skirts": [.waist, .length]]),
        "dresses": ([.pitToPit, .waist, .length], ["jumpsuits_rompers": whole]),
        "activewear": (whole, ["tops": top, "bottoms": bottom, "sports_bras": [.pitToPit]]),
        "swimwear": ([], ["swim_trunks": [.waist, .inseam, .length], "cover_ups": top]),
        "sleep_lounge": (whole, [:]),
        "suits_sets": (whole, [:]),
    ]
}

/// One measurement of an item: inches or centimeters, as the contract's `Measurement` keeps it.
public struct ItemMeasurement: Equatable, Hashable, Sendable {
    public enum Unit: String, Sendable {
        case inches = "in"
        case centimeters = "cm"
    }

    /// The canonical name (``MeasurementKind/rawValue`` for the ones the review asks for).
    public let name: String
    public let value: Double
    public let unit: Unit

    public init(name: String, value: Double, unit: Unit) {
        self.name = name
        self.value = value
        self.unit = unit
    }

    public var kind: MeasurementKind? {
        MeasurementKind(rawValue: name)
    }

    /// "Pit to pit", or the canonical name in words for one this app does not ask for.
    public var title: String {
        kind?.title ?? name.replacingOccurrences(of: "_", with: " ").capitalizedFirst
    }

    /// `21"`, `21.5"`, `53 cm`: the number without trailing zeros, and the unit as resale
    /// listings write it.
    public var valueText: String {
        let number = Self.number(value)
        return switch unit {
        case .inches: "\(number)\""
        case .centimeters: "\(number) cm"
        }
    }

    /// `measurements` in the order a buyer reads them for an item of `category`: the ones that fit
    /// it (``MeasurementKind/fitting(category:)``), then the review's other kinds, then any other.
    public static func ordered(_ measurements: [ItemMeasurement], category: String?) -> [ItemMeasurement] {
        let order = MeasurementKind.fitting(category: category)
            + MeasurementKind.allCases.filter { !MeasurementKind.fitting(category: category).contains($0) }
        return measurements.enumerated().sorted { lhs, rhs in
            let left = lhs.element.kind.flatMap(order.firstIndex(of:)) ?? order.count
            let right = rhs.element.kind.flatMap(order.firstIndex(of:)) ?? order.count
            return left == right ? lhs.offset < rhs.offset : left < right
        }.map(\.element)
    }

    /// The number with at most two decimals and no trailing zeros: 21, 21.5, 21.25.
    public static func number(_ value: Double) -> String {
        let hundredths = (value * 100).rounded()
        let whole = Int64(hundredths / 100)
        let fraction = Int64(hundredths) % 100
        guard fraction != 0 else { return "\(whole)" }
        return fraction.isMultiple(of: 10) ? "\(whole).\(fraction / 10)" : String(
            format: "%lld.%02lld",
            whole,
            fraction,
        )
    }
}

extension String {
    fileprivate var capitalizedFirst: String {
        prefix(1).uppercased() + dropFirst()
    }
}
