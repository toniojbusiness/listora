import Core
import Foundation
import ListoraAPI

/// One row of the review's measurements: a measurement that fits the item's category, or one the
/// item already has.
struct MeasurementRow: Equatable, Identifiable, Sendable {
    let kind: MeasurementKind
    let measurement: ItemMeasurement?

    var id: MeasurementKind {
        kind
    }
}

extension ReviewForm {
    /// The measurements the review asks for: those that fit the item's category, in the order a
    /// buyer reads them, then any other the item already has (its category changed), so a value
    /// is never hidden.
    var measurementRows: [MeasurementRow] {
        let category = details.category
        var kinds = MeasurementKind.fitting(category: category)
        for measurement in details.itemMeasurements {
            if let kind = measurement.kind, !kinds.contains(kind) {
                kinds.append(kind)
            }
        }
        return kinds.map { MeasurementRow(kind: $0, measurement: details.measurement(named: $0.rawValue)) }
    }

    /// The item's measurements in the review's order, as the Depop description lists them.
    var measurementsForCopy: [ItemMeasurement] {
        ItemMeasurement.ordered(details.itemMeasurements, category: details.category)
    }
}

extension ItemDetails {
    /// The item's measurements as Core's type.
    var itemMeasurements: [ItemMeasurement] {
        (measurements ?? []).map(ItemMeasurement.init)
    }

    func measurement(named name: String) -> ItemMeasurement? {
        measurements?.first { $0.name == name }.map(ItemMeasurement.init)
    }

    /// Sets the measurement called `name`; nil removes it, and no measurements left removes the
    /// detail (absent means no value).
    mutating func setMeasurement(named name: String, to measurement: ItemMeasurement?) {
        var list = (measurements ?? []).filter { $0.name != name }
        if let measurement {
            list.append(Components.Schemas.Measurement(
                name: name,
                value: measurement.value,
                unit: measurement.unit == .centimeters ? .cm : ._in,
            ))
        }
        measurements = list.isEmpty ? nil : list
    }
}

extension ItemMeasurement {
    init(_ measurement: Components.Schemas.Measurement) {
        self.init(
            name: measurement.name,
            value: measurement.value,
            unit: measurement.unit == .cm ? .centimeters : .inches,
        )
    }
}

/// A measurement typed on the in-app keypad: digits, at most one decimal point, and at most two
/// digits after it ("21", "21.5", "15.25"); keys that would make an invalid number are ignored.
struct MeasurementEntry: Equatable, Sendable {
    /// 999.99 is more than any garment measures, in inches or centimeters.
    static let maxWholeDigits = 3

    private(set) var text = ""

    init() {}

    init(value: Double) {
        text = ItemMeasurement.number(value)
    }

    mutating func press(_ key: AmountEntry.Key) {
        switch key {
        case let .digit(digit):
            guard (0 ... 9).contains(digit) else { return }
            let parts = text.split(separator: ".", omittingEmptySubsequences: false)
            if parts.count == 2 {
                guard parts[1].count < 2 else { return }
            } else {
                guard text.count < Self.maxWholeDigits else { return }
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

    /// The number typed; nil while empty or zero (no garment measures nothing).
    var value: Double? {
        let digits = text.hasSuffix(".") ? String(text.dropLast()) : text
        guard let value = Double(digits), value > 0 else { return nil }
        return value
    }
}
