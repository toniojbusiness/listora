import APIClient
import Core
import Foundation
import ListoraAPI
import Observation

/// The List flow: pick the marketplaces, then review each one's version of the listing and send
/// it. eBay goes through its API; an assisted marketplace (Poshmark, Mercari, Depop until its API
/// is connected) gets a task in the Tasks tab, which the user finishes in the marketplace's app.
/// Sending only queues the listing: the item screen then shows the server's progress until eBay
/// confirms it, or the user confirms the task.
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
        /// "Through eBay's API", "Connect eBay in Settings first", "Assisted - ...".
        let detail: String
        let isAvailable: Bool
        let isAssisted: Bool
    }

    /// eBay's title limit (`EBAY_LIMITS.title` on the server).
    static let ebayTitleLimit = 80
    /// The marketplaces whose listing names one of their categories, which Listora maps or the
    /// seller picks.
    static let categorized: Set<String> = ["poshmark", "mercari", "depop"]

    private(set) var step: Step = .choose
    private(set) var choices: [Choice] = []
    var selected: Set<String> = []
    /// An edit answers the last refusal, so its message goes until the next send says otherwise.
    var title = "" {
        didSet {
            if title != oldValue {
                problem = nil
            }
        }
    }

    var description = "" {
        didSet {
            if description != oldValue {
                problem = nil
            }
        }
    }

    /// The price in cents (``PriceField`` edits it); nil while empty.
    var priceCents: Int? {
        didSet {
            if priceCents != oldValue {
                problem = nil
            }
        }
    }

    /// Why the listing can't be sent as it is, from the server or this screen; it clears once the
    /// seller edits the listing.
    private(set) var problem: String?
    /// The categories of the marketplace on screen, for Poshmark, Mercari, and Depop: the one
    /// Listora maps the item to, or none, and then the seller picks (`chooseCategory`).
    private(set) var categories: Components.Schemas.MarketplaceCategories?
    /// What the seller picked, by marketplace (a `variant.categoryRef`).
    private var chosenCategories: [String: Components.Schemas.MarketplaceCategory] = [:]
    private(set) var isPublishing = false
    private(set) var isPreparing = true
    /// The marketplaces being reviewed, in picker order, and the one on screen.
    private(set) var queue: [Choice] = []
    private(set) var position = 0

    private let item: Item
    private let service: any InventoryService
    private let listingCopy: ListingCopyStore
    private let preferred: String?
    /// Each marketplace's draft, once created (kept so a second try reuses it).
    private var draftIDs: [String: String] = [:]
    /// The Idempotency-Keys of each draft being created and of each publish, reused when an
    /// answer is lost so a second tap never queues the listing twice.
    private var createKeys: [String: String] = [:]
    private var publishKeys: [String: String] = [:]

    /// `marketplace` is the one the seller chose List on, selected from the start.
    init(item: Item, service: any InventoryService, listingCopy: ListingCopyStore, marketplace: String? = nil) {
        self.item = item
        self.service = service
        self.listingCopy = listingCopy
        preferred = marketplace
        for listing in item.listings where listing.status.value1 == .draft {
            draftIDs[listing.marketplace.id] = listing.id
        }
    }

    /// Loads the marketplaces' connections and works out where the item can be listed.
    func prepare() async {
        isPreparing = true
        defer { isPreparing = false }
        let connections = await (try? service.connections()) ?? []
        choices = KnownMarketplace.allCases.map { marketplace in
            choice(for: marketplace, connection: connections.first { $0.marketplace.value1 == marketplace })
        }
        if let preferred, choices.contains(where: { $0.id == preferred && $0.isAvailable }) {
            selected = [preferred]
        } else {
            selected = Set(choices.filter { $0.isAvailable && !$0.isAssisted }.map(\.id))
        }
    }

    var canContinue: Bool {
        !selected.isEmpty
    }

    /// The marketplace on the review screen.
    var current: Choice? {
        queue.indices.contains(position) ? queue[position] : nil
    }

    /// "eBay" and "Publish to eBay", or "Poshmark" and "Create Poshmark task".
    var sendTitle: String {
        guard let current else { return "Publish" }
        return current.isAssisted ? "Create \(current.name) task" : "Publish to \(current.name)"
    }

    /// The title limit of the marketplace on screen, when Listora knows it.
    var titleLimit: Int? {
        current?.id == KnownMarketplace.ebay.rawValue ? Self.ebayTitleLimit : nil
    }

    func next() async {
        guard canContinue else { return }
        problem = nil
        queue = choices.filter { selected.contains($0.id) && $0.isAvailable }
        position = 0
        await fillCopy()
        step = .review
    }

    func back() {
        step = .choose
    }

    var titleCount: Int {
        title.utf16.count
    }

    /// The category the listing goes in on the marketplace on screen: the seller's pick, else
    /// the one Listora maps the item to; `nil` while there is neither.
    var category: Components.Schemas.MarketplaceCategory? {
        guard let marketplace = current?.id else { return nil }
        return chosenCategories[marketplace] ?? categories?.suggested
    }

    /// Whether the seller has to pick the category before this marketplace can take it.
    var needsCategory: Bool {
        categories != nil && category == nil
    }

    func chooseCategory(_ choice: Components.Schemas.MarketplaceCategory) {
        guard let marketplace = current?.id else { return }
        chosenCategories[marketplace] = choice
        problem = nil
    }

    /// What this screen already knows the marketplace would refuse; the server checks again.
    var localProblem: String? {
        if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Add a title."
        }
        if needsCategory {
            return "Choose a \(current?.name ?? "marketplace") category."
        }
        if let titleLimit, titleCount > titleLimit {
            return "The title is \(titleCount) characters; \(current?.name ?? "the marketplace") allows \(titleLimit)."
        }
        guard let priceCents, priceCents > 0 else { return "Enter a price above $0." }
        return nil
    }

    /// Creates (or updates) the marketplace's draft and sends it. Returns true once the last
    /// marketplace is queued; before that, the next one's review is on screen.
    func publish() async -> Bool {
        guard !isPublishing, let current else { return false }
        if let localProblem {
            problem = localProblem
            return false
        }
        isPublishing = true
        problem = nil
        defer { isPublishing = false }
        let marketplace = current.id
        let key = publishKeys[marketplace] ?? UUID().uuidString
        publishKeys[marketplace] = key
        do {
            let listingID = try await saveDraft(marketplace: marketplace)
            _ = try await service.perform(.publish(listingID: listingID), idempotencyKey: key)
        } catch {
            // A refusal is final for this key; an answer that never arrived is sent again as is.
            if error.statusCode != nil {
                publishKeys[marketplace] = nil
            }
            problem = error.message
            return false
        }
        guard position + 1 < queue.count else { return true }
        position += 1
        await fillCopy()
        return false
    }

    // MARK: Private

    private func choice(for marketplace: KnownMarketplace, connection: Connection?) -> Choice {
        let id = marketplace.rawValue
        let name = Formatting.marketplaceName(id)
        let assisted = MarketplaceRowState.isAssisted(marketplace: marketplace, connection: connection)
        if let listing = item.listings.first(where: { $0.marketplace.value1 == marketplace }),
           listing.status.value1 != .draft
        {
            return Choice(
                id: id,
                name: name,
                detail: "Already on \(name). Change it from the item screen.",
                isAvailable: false,
                isAssisted: assisted,
            )
        }
        if !MarketplaceRowState.canList(marketplace: marketplace, connection: connection) {
            return Choice(
                id: id,
                name: name,
                detail: "Connect \(name) in Settings > Marketplaces first",
                isAvailable: false,
                isAssisted: assisted,
            )
        }
        return Choice(
            id: id,
            name: name,
            detail: assisted
                ? "Assisted - Listora makes a task with everything to copy; you post it in the \(name) app."
                : connection?.mode.value1 == .automation
                ? "Automated in your \(name) session"
                : "Through \(name)'s API",
            isAvailable: true,
            isAssisted: assisted,
        )
    }

    private func variant() -> ListingVariant {
        ListingVariant(
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description,
            price: Money(amountCents: Int64(priceCents ?? 0), currency: .usd),
            categoryRef: current.flatMap { chosenCategories[$0.id]?.ref },
            condition: item.details.condition,
        )
    }

    private func saveDraft(marketplace: String) async throws(APIFailure) -> String {
        if let draftID = draftIDs[marketplace] {
            _ = try await service.replaceDraft(listingID: draftID, variant: variant())
            return draftID
        }
        guard let known = KnownMarketplace(rawValue: marketplace) else {
            throw APIFailure(
                statusCode: nil,
                code: "invalid_request",
                message: "This version of Listora can't list here.",
                retryable: false,
            )
        }
        let key = createKeys[marketplace] ?? UUID().uuidString
        createKeys[marketplace] = key
        let listing = try await service.createListing(
            itemID: item.id,
            marketplace: known,
            variant: variant(),
            idempotencyKey: key,
        )
        draftIDs[marketplace] = listing.id
        return listing.id
    }

    /// For the marketplace on screen: its draft's copy, else the seller's own copy from the
    /// review if they edited it, else the analysis's copy for it, else the item's title and
    /// description; the price is the item's list price.
    private func fillCopy() async {
        guard let marketplace = current?.id else { return }
        problem = nil
        categories = nil
        if Self.categorized.contains(marketplace) {
            categories = try? await service.marketplaceCategories(itemID: item.id, marketplace: marketplace)
        }
        if let draftID = draftIDs[marketplace],
           let variant = item.listings.first(where: { $0.id == draftID })?.variant
        {
            title = variant.title
            description = variant.description
            priceCents = Int(variant.price.amountCents)
            return
        }
        let edited = listingCopy.edits(itemID: item.id)[marketplace]
        var suggested: Components.Schemas.VariantSuggestion?
        if edited == nil, let analysisID = item.details.acceptedAnalysisId {
            suggested = try? await service.analysisVariants(analysisID: analysisID)
                .first { $0.marketplace.id == marketplace }
        }
        title = edited?.title ?? suggested?.title ?? item.details.title ?? ""
        description = edited?.description ?? suggested?.description ?? item.details.description ?? ""
        priceCents = item.details.listPrice.map { Int($0.amountCents) }
    }
}
