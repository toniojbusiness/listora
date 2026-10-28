import APIClient
import DesignSystem
import ListoraAPI
import Observation
import SwiftUI

/// The item's own refresh cadence over the account's (docs/features/listing-refresh.md): one
/// menu under the marketplaces. Choosing saves at once; it changes no listing by itself.
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

    /// The named choices; a custom time is the account setting's (Settings > Listing refresh).
    private static let choices: [Components.Schemas.KnownRefreshCadence] = [
        .every72Hours, .daily, .everyFewDays, .weekly, .off,
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Menu {
                Button("My setting") { Task { await model.choose(nil) } }
                ForEach(Self.choices, id: \.self) { cadence in
                    Button(RefreshWords.name(cadence)) { Task { await model.choose(cadence) } }
                }
            } label: {
                ListRow("Refresh this item", subtitle: model.label, systemImage: "arrow.clockwise") {
                    if testing {
                        TestingTag()
                    }
                    Image(systemName: "chevron.up.chevron.down")
                        .foregroundStyle(Palette.textSecondary)
                        .accessibilityHidden(true)
                }
            }
            .disabled(model.refresh == nil || model.isSaving)
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
