import APIClient
import Foundation
import ListoraAPI

/// The marketplace pre-fill on the review (docs/features/marketplace-prefill.md): each
/// marketplace's own category, size, and the details its form shows, worked out by the server
/// from the review's details as they are now, and the few questions Listora isn't sure of, each
/// one tap on a ranked short list, answered before the seller lists.
extension ReviewFlowModel {
    /// The details the pre-fill reads; editing any of them works it out again.
    static let prefillKeys: Set<ReviewFieldKey> = [
        .category, .department, .sizeLabel, .sizeSystem, .brand, .condition, .colors, .materials,
    ]

    /// The details the pre-fill reads, as the review has them now (unsaved edits included); an
    /// empty value means none.
    var currentPrefillDetails: PrefillDetails? {
        guard let details = form?.details else { return nil }
        return PrefillDetails(
            category: details.category ?? "",
            department: details.department ?? "",
            sizeLabel: details.sizeLabel ?? "",
            sizeSystem: details.sizeSystem ?? "",
            brand: details.brand ?? "",
            condition: details.condition?.rawValue ?? "",
            colors: (details.colors ?? []).joined(separator: ","),
            materials: (details.materials ?? []).joined(separator: ","),
        )
    }

    /// The marketplaces Listora lists on itself, whose forms the review shows.
    var prefillMarketplaces: [Components.Schemas.MarketplacePrefill] {
        prefill?.marketplaces.filter(\.connected) ?? []
    }

    /// Questions about the item every marketplace follows (girls or boys), shown with them.
    var prefillItemFields: [Components.Schemas.PrefillField] {
        prefillMarketplaces.isEmpty ? [] : prefill?.itemFields ?? []
    }

    /// How many taps the marketplaces still need before the item can list on them.
    var marketplaceQuestions: Int {
        prefill?.questions ?? 0
    }

    /// Reads the pre-fill for the review's details, unless it is already for them. A failed read
    /// keeps the one on screen: the List flow checks every marketplace again before it lists.
    func refreshPrefill() async {
        guard let item, let details = currentPrefillDetails, prefill == nil || details != prefillDetails else { return }
        prefillDetails = details
        do {
            let answer = try await service.marketplacePrefill(itemID: item.id, details: details)
            // A newer edit asked again meanwhile: its answer is the one to show.
            if prefillDetails == details {
                prefill = answer
            }
        } catch {
            log.error("Pre-fill failed: \(error.code, privacy: .public)")
            if prefillDetails == details {
                prefillDetails = nil
            }
        }
    }

    /// The seller edited a detail the pre-fill reads: works it out again.
    func prefillDetailsChanged() {
        prefillRefresh?.cancel()
        prefillRefresh = Task { await refreshPrefill() }
    }

    /// Sends the seller's tap on a question (`value` nil clears it) and shows the answer.
    func answerPrefill(field: Components.Schemas.PrefillAnswerField, marketplace: String?, value: String?) async {
        guard let item, let details = currentPrefillDetails, !isAnsweringPrefill else { return }
        isAnsweringPrefill = true
        defer { isAnsweringPrefill = false }
        let answer = PrefillAnswer(
            marketplace: marketplace.flatMap(Components.Schemas.KnownMarketplace.init(rawValue:)),
            field: field,
            value: value,
            details: details,
        )
        do {
            prefill = try await service.answerPrefill(itemID: item.id, answer: answer)
            prefillDetails = details
        } catch {
            actionError = error.message
        }
    }

    /// Every category of a marketplace, for "More categories".
    func allCategories(marketplace: String) async -> [Components.Schemas.MarketplaceCategory] {
        guard let item else { return [] }
        do {
            return try await service.marketplaceCategories(itemID: item.id, marketplace: marketplace).choices
        } catch {
            actionError = error.message
            return []
        }
    }
}
