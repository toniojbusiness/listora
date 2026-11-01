import Core
import Foundation

extension ReviewFlowModel {
    // MARK: Measurements

    /// The marketplaces' copy from the analysis, the seller's edits, and the item's measurements
    /// as the form has them now.
    func refreshCopies() {
        guard let item else { return }
        copies = MarketplaceCopy.copies(
            result: analysis?.result,
            edits: listingCopy.edits(itemID: item.id),
            measurements: form?.measurementsForCopy ?? [],
        )
    }

    /// Sets a measurement as the seller's edit (typed or spoken) and writes it into the copy; nil
    /// removes it. Saved with Continue like the other details.
    func setMeasurement(_ kind: MeasurementKind, to value: Double?) {
        let unit = form?.details.measurement(named: kind.rawValue)?.unit ?? .inches
        form?.setMeasurement(
            named: kind.rawValue,
            to: value.map { ItemMeasurement(name: kind.rawValue, value: $0, unit: unit) },
        )
        refreshCopies()
    }

    /// A measurement typed on the review's keypad: the open editor's text is kept first.
    func enterMeasurement(_ kind: MeasurementKind, _ value: Double?) {
        focusedField = nil
        commitEditing()
        setMeasurement(kind, to: value)
    }
}
