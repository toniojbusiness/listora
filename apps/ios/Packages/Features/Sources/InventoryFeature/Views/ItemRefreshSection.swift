import APIClient
import DesignSystem
import ListoraAPI
import Observation
import SwiftUI

/// The item's own refresh cadence over the account's (docs/features/listing-refresh.md): its
/// choices as chips under the marketplaces, the one in use checked. Choosing saves at once; it
/// changes no listing by itself.
@MainActor
@Observable
final class ItemRefreshModel {
    private(set) var refresh: Components.Schemas.ItemRefresh?
    private(set) var isSaving = false
    private(set) var saveError: String?

    let itemID: String
    private let service: any ListingRefreshService

    init(itemID: String, service: any ListingRefreshService) {
        self.itemID = itemID
        self.service = service
    }

    func load() async {
        refresh = try? await service.itemRefresh(itemID: itemID)
    }

    /// Gives the item its own cadence, or (`nil`) the account's again.
    func choose(_ cadence: Components.Schemas.KnownRefreshCadence?) async {
        isSaving = true
        saveError = nil
        defer { isSaving = false }
        do {
            refresh = try await service.saveItemRefresh(itemID: itemID, .init(cadence: cadence))
        } catch {
            saveError = error.message
        }
    }

    /// Whether `cadence` is the one in use: `nil` is the account's setting. Nothing is checked
    /// until it loads, or for a custom time the item screen doesn't offer.
    func isChosen(_ cadence: Components.Schemas.KnownRefreshCadence?) -> Bool {
        guard let refresh else { return false }
        guard let own = refresh.cadence else { return cadence == nil }
        return cadence != nil && own.value1 == cadence
    }

    /// "My setting (every 72 hours)": the account's cadence, for its chip.
    var accountLabel: String {
        guard let refresh else { return "My setting" }
        let account = RefreshWords.name(refresh.accountCadence, customHours: refresh.accountCustomHours)
        return "My setting (\(account.lowercased()))"
    }

    /// The line under the title: how to change it, or the item's own custom time, which no chip
    /// shows.
    var hint: String {
        if refresh?.cadence?.value1 == .custom {
            return "\(label). Tap one to change how often."
        }
        return "Tap one to change how often."
    }

    /// "My setting (every 72 hours)", or the item's own cadence.
    var label: String {
        guard let refresh else { return "Loading..." }
        if let own = refresh.cadence {
            return RefreshWords.name(own, customHours: refresh.customHours)
        }
        let account = RefreshWords.name(refresh.accountCadence, customHours: refresh.accountCustomHours)
        return "My setting (\(account.lowercased()))"
    }
}

struct ItemRefreshSection: View {
    @State private var model: ItemRefreshModel
    /// Refresh shows only because of the owner's Test mode (docs/features/test-mode.md).
    private let testing: Bool

    init(itemID: String, service: any ListingRefreshService, testing: Bool = false) {
        _model = State(initialValue: ItemRefreshModel(itemID: itemID, service: service))
        self.testing = testing
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            ListRow("Refresh this item", subtitle: model.hint, systemImage: "arrow.clockwise") {
                if testing {
                    TestingTag()
                }
            }
            FlowLayout {
                ChoiceChip(model.accountLabel, isSelected: model.isChosen(nil)) {
                    Task { await model.choose(nil) }
                }
                .accessibilityIdentifier("item.refresh.account")
                ForEach(RefreshWords.itemCadences, id: \.self) { cadence in
                    ChoiceChip(RefreshWords.name(cadence), isSelected: model.isChosen(cadence)) {
                        Task { await model.choose(cadence) }
                    }
                    .accessibilityIdentifier("item.refresh.\(cadence.rawValue)")
                }
            }
            .disabled(model.refresh == nil || model.isSaving)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Refresh this item")
            .accessibilityIdentifier("item.refresh")
            if let error = model.saveError {
                Text(error)
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .cardStyle(.ruled)
        .task { await model.load() }
    }
}
