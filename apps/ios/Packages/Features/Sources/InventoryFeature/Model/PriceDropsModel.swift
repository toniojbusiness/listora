import APIClient
import Foundation
import ListoraAPI
import Observation

/// Settings > Price drops, and the item screen's price drop (docs/features/price-drops.md): the
/// seller's rules with their switches, and every drop planned before it runs. With an item, only
/// the rule that applies to it and its listings' drops.
@MainActor
@Observable
final class PriceDropsModel {
    enum Phase: Equatable {
        case loading
        case loaded
        case failed(message: String)
    }

    private(set) var phase: Phase = .loading
    private(set) var rules: [Components.Schemas.PriceDropRule] = []
    private(set) var planned: [Components.Schemas.PlannedPriceDrop] = []
    /// A rule whose switch is being saved.
    private(set) var savingRuleID: String?
    /// The last change's failure, safe to show.
    private(set) var changeError: String?

    let itemID: String?
    let service: any PriceDropService

    init(itemID: String? = nil, service: any PriceDropService) {
        self.itemID = itemID
        self.service = service
    }

    func load() async {
        if rules.isEmpty, planned.isEmpty {
            phase = .loading
        }
        do {
            try await apply(service.priceDrops(itemID: itemID))
            phase = .loaded
        } catch {
            if phase != .loaded {
                phase = .failed(message: error.message)
            } else {
                changeError = error.message
            }
        }
    }

    /// Turns the rule on or off. A failure leaves the switch as it was and says why.
    func setEnabled(_ enabled: Bool, for rule: Components.Schemas.PriceDropRule) async {
        savingRuleID = rule.id
        changeError = nil
        defer { savingRuleID = nil }
        do {
            _ = try await service.replace(
                ruleID: rule.id,
                .init(percent: rule.percent, afterDays: rule.afterDays, floor: rule.floor, enabled: enabled),
            )
            try await apply(service.priceDrops(itemID: itemID))
        } catch {
            changeError = enabled
                ? "Couldn't turn on this rule. \(error.message)"
                : "Couldn't turn off this rule. \(error.message)"
        }
    }

    /// The item's own rule, when it has one (on the item screen).
    var itemRule: Components.Schemas.PriceDropRule? {
        rules.first { $0.scope.value1 == .item }
    }

    /// The brand rules, by name.
    var brandRules: [Components.Schemas.PriceDropRule] {
        rules.filter { $0.scope.value1 == .brand }
    }

    /// The item rules (Settings shows them under the brands).
    var itemRules: [Components.Schemas.PriceDropRule] {
        rules.filter { $0.scope.value1 != .brand }
    }

    /// The drops due to run, soonest first.
    var scheduled: [Components.Schemas.PlannedPriceDrop] {
        planned.filter { $0.state.value1 == .scheduled }
    }

    /// The listings a rule covers that won't drop now: at the floor, paused, or unavailable.
    var waiting: [Components.Schemas.PlannedPriceDrop] {
        planned.filter { $0.state.value1 != .scheduled }
    }

    private func apply(_ drops: Components.Schemas.PriceDrops) {
        rules = drops.rules
        planned = drops.planned
    }
}
