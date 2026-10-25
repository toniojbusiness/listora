import APIClient
import Core
import Foundation
import ListoraAPI
import Observation

/// The List flow: pick the marketplaces, review the eBay version of the listing, and publish.
/// eBay goes through its API; the other marketplaces show how Listora works with them now
/// (assisted, which this flow does not start yet). Publishing only queues the listing: the item
/// screen then shows the server's progress until eBay confirms it.
@MainActor
@Observable
final class ListingFlowModel {
    enum Step: Equatable {
        case choose
        case review
    }

    /// One marketplace in the picker.
    struct Choice: Identifiable, Equatable, Sendable {
        let id: String
        let name: String
        /// "Through eBay's API", "Connect eBay in Settings first", "Assisted - coming soon".
        let detail: String
        let isAvailable: Bool
    }

    /// eBay's title limit (`EBAY_LIMITS.title` on the server).
    static let ebayTitleLimit = 80

    private(set) var step: Step = .choose
    private(set) var choices: [Choice] = []
    var selected: Set<String> = []
    var title = ""
    var description = ""
    var price = ""
    /// Why the listing can't be published as it is, from the server or this screen.
    private(set) var problem: String?
    private(set) var isPublishing = false
    private(set) var isPreparing = true

    private let item: Item
    private let service: any InventoryService
    private let listingCopy: ListingCopyStore
    /// The item's eBay draft, once created (kept so a second try reuses it).
    private var draftID: String?
    /// The Idempotency-Keys of the draft being created and of the publish, reused when an
    /// answer is lost so a second tap never queues the listing twice.
    private let createKey = UUID().uuidString
    private var publishKey = UUID().uuidString

    init(item: Item, service: any InventoryService, listingCopy: ListingCopyStore) {
        self.item = item
        self.service = service
        self.listingCopy = listingCopy
        draftID = item.listings.first { $0.marketplace.value1 == .ebay && $0.status.value1 == .draft }?.id
    }

    /// Loads the marketplaces' connections and the copy to start the review from.
    func prepare() async {
        isPreparing = true
        defer { isPreparing = false }
        let connections = await (try? service.connections()) ?? []
        choices = KnownMarketplace.allCases.map { marketplace in
            let connection = connections.first { $0.marketplace.value1 == marketplace }
            let name = Formatting.marketplaceName(marketplace.rawValue)
            if MarketplaceRowState.canList(connection: connection) {
                return Choice(id: marketplace.rawValue, name: name, detail: "Through \(name)'s API", isAvailable: true)
            }
            if connection?.mode.value1 == .api || marketplace == .ebay {
                return Choice(
                    id: marketplace.rawValue,
                    name: name,
                    detail: "Connect \(name) in Settings > Marketplaces first",
                    isAvailable: false,
                )
            }
            return Choice(
                id: marketplace.rawValue,
                name: name,
                detail: "Assisted - you'll finish it in the \(name) app. Coming soon.",
                isAvailable: false,
            )
        }
        selected = Set(choices.filter(\.isAvailable).map(\.id))
        await fillCopy()
    }

    var canContinue: Bool {
        selected.contains(KnownMarketplace.ebay.rawValue)
    }

    func next() {
        guard canContinue else { return }
        problem = nil
        step = .review
    }

    func back() {
        step = .choose
    }

    var titleCount: Int {
        title.utf16.count
    }

    /// What this screen already knows eBay would refuse; the server checks everything again.
    var localProblem: String? {
        if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Add a title."
        }
        if titleCount > Self.ebayTitleLimit {
            return "The title is \(titleCount) characters; eBay allows \(Self.ebayTitleLimit)."
        }
        guard let cents = Formatting.cents(from: price), cents > 0 else { return "Enter a price above $0." }
        return nil
    }

    /// Creates (or updates) the eBay draft and publishes it. Returns true once the server has
    /// queued the publish; the item screen then follows it.
    func publish() async -> Bool {
        guard !isPublishing else { return false }
        if let localProblem {
            problem = localProblem
            return false
        }
        isPublishing = true
        problem = nil
        defer { isPublishing = false }
        do {
            let listingID = try await saveDraft()
            _ = try await service.perform(.publish(listingID: listingID), idempotencyKey: publishKey)
            return true
        } catch {
            // A refusal is final for this key; an answer that never arrived is sent again as is.
            if error.statusCode != nil {
                publishKey = UUID().uuidString
            }
            problem = error.message
            return false
        }
    }

    private func variant() -> ListingVariant {
        ListingVariant(
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description,
            price: Money(amountCents: Formatting.cents(from: price) ?? 0, currency: .usd),
            condition: item.details.condition,
        )
    }

    private func saveDraft() async throws(APIFailure) -> String {
        if let draftID {
            _ = try await service.replaceDraft(listingID: draftID, variant: variant())
            return draftID
        }
        let listing = try await service.createListing(
            itemID: item.id,
            marketplace: .ebay,
            variant: variant(),
            idempotencyKey: createKey,
        )
        draftID = listing.id
        return listing.id
    }

    /// The seller's own eBay copy from the review if they edited it, else the analysis's eBay
    /// copy, else the item's title and description; the price is the item's list price.
    private func fillCopy() async {
        if let draft = item.listings.first(where: { $0.id == draftID }), let variant = draft.variant {
            title = variant.title
            description = variant.description
            price = Formatting.editableAmount(cents: variant.price.amountCents)
            return
        }
        let edited = listingCopy.edits(itemID: item.id)[KnownMarketplace.ebay.rawValue]
        var suggested: Components.Schemas.VariantSuggestion?
        if edited == nil, let analysisID = item.details.acceptedAnalysisId {
            suggested = try? await service.analysisVariants(analysisID: analysisID)
                .first { $0.marketplace.value1 == .ebay }
        }
        title = edited?.title ?? suggested?.title ?? item.details.title ?? ""
        description = edited?.description ?? suggested?.description ?? item.details.description ?? ""
        if let listPrice = item.details.listPrice {
            price = Formatting.editableAmount(cents: listPrice.amountCents)
        }
    }
}
