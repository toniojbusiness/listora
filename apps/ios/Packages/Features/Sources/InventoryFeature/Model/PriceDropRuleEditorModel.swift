import APIClient
import Foundation
import ListoraAPI
import Observation

/// A new rule (for a brand or one item) or a rule being changed: its terms with the defaults
/// from the seller's own days to sell, and its switch.
@MainActor
@Observable
final class PriceDropRuleEditorModel {
    enum Target: Equatable {
        /// A new rule for a brand the seller names.
        case newBrand
        /// A new rule for one item, of this brand.
        case newItem(itemID: String, brand: String?)
        /// An existing rule.
        case existing(Components.Schemas.PriceDropRule)
    }

    static let percentRange = 1 ... 50
    static let daysRange = 1 ... 365

    let target: Target
    var brand = ""
    var percent = 10
    var afterDays = 21
    /// The lowest price, in cents (0 until entered).
    var floorCents: Int64 = 0
    var enabled = true
    private(set) var defaults: Components.Schemas.PriceDropDefaults?
    private(set) var isSaving = false
    private(set) var saveError: String?

    private let service: any PriceDropService

    init(target: Target, service: any PriceDropService) {
        self.target = target
        self.service = service
        if case let .existing(rule) = target {
            percent = Int(rule.percent)
            afterDays = Int(rule.afterDays)
            floorCents = rule.floor.amountCents
            enabled = rule.enabled
            brand = rule.brand ?? ""
        }
    }

    /// Reads the defaults for a new rule; an existing rule keeps its terms.
    func loadDefaults() async {
        let itemID: String?
        switch target {
        case .existing: return
        case .newBrand: itemID = nil
        case let .newItem(id, _): itemID = id
        }
        let brandName = brand.trimmingCharacters(in: .whitespaces)
        guard let read = try? await service.defaults(
            itemID: itemID,
            brand: itemID == nil && !brandName.isEmpty ? brandName : nil,
        ) else { return }
        defaults = read
        percent = Int(read.percent)
        afterDays = Int(read.afterDays)
        if floorCents == 0, let floor = read.floor {
            floorCents = floor.amountCents
        }
    }

    var isNew: Bool {
        if case .existing = target {
            return false
        }
        return true
    }

    /// What is missing before it can be saved, in words; nil when it can be.
    var missing: String? {
        if case .newBrand = target, brand.trimmingCharacters(in: .whitespaces).isEmpty {
            return "Enter the brand as it is on the tag."
        }
        if floorCents < 100 {
            return "Enter the lowest price, at least $1."
        }
        return nil
    }

    /// The rule as it will read.
    var summary: String {
        PriceDropWords.terms(
            percent: percent,
            afterDays: afterDays,
            floor: .init(amountCents: floorCents, currency: .usd),
        )
    }

    /// Saves the rule; true when the server has it.
    func save() async -> Bool {
        guard missing == nil else { return false }
        isSaving = true
        saveError = nil
        defer { isSaving = false }
        let floor = Components.Schemas.Money(amountCents: floorCents, currency: .usd)
        do {
            switch target {
            case .newBrand:
                _ = try await service.create(.init(
                    brand: brand.trimmingCharacters(in: .whitespaces),
                    percent: Int32(percent),
                    afterDays: Int32(afterDays),
                    floor: floor,
                ))
            case let .newItem(itemID, _):
                _ = try await service.create(.init(
                    itemId: itemID,
                    percent: Int32(percent),
                    afterDays: Int32(afterDays),
                    floor: floor,
                ))
            case let .existing(rule):
                _ = try await service.replace(
                    ruleID: rule.id,
                    .init(percent: Int32(percent), afterDays: Int32(afterDays), floor: floor, enabled: enabled),
                )
            }
            return true
        } catch {
            saveError = error.message
            return false
        }
    }

    /// Deletes an existing rule; true when it is gone.
    func delete() async -> Bool {
        guard case let .existing(rule) = target else { return false }
        isSaving = true
        saveError = nil
        defer { isSaving = false }
        do {
            try await service.delete(ruleID: rule.id)
            return true
        } catch {
            saveError = error.message
            return false
        }
    }
}
