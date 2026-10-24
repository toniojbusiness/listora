import APIClient
import Core
import Foundation
import Observation

/// The Share Extension's flow: read the shared listing URL, let the user pick the item it
/// belongs to (or create a placeholder item), confirm, and record the link. The link is the
/// user's confirmation; the server's answer, not this model, says what was recorded.
@MainActor
@Observable
public final class ShareLinkModel {
    /// What to link the listing to.
    public enum Target: Equatable, Sendable {
        case existing(ItemMatch)
        case newItem(title: String)
    }

    public enum Phase: Equatable {
        /// The share is not a listing on a supported marketplace.
        case unsupported(title: String, message: String)
        /// No session: the user must sign in in the app first.
        case signedOut
        /// Searching for the item, or naming a new one.
        case choosing
        /// The user reviews what will be recorded.
        case confirming(Target)
        case submitting(Target)
        case linked(LinkedListing)
        /// The link was not recorded. `error.retryable` says whether "Try again" may help.
        case failed(Target, APIFailure)
    }

    public enum SearchState: Equatable {
        case idle
        case searching
        case loaded
        case failed(APIFailure)
    }

    public private(set) var phase: Phase
    public private(set) var results: [ItemMatch] = []
    public private(set) var searchState: SearchState = .idle
    /// The search text: a title, brand, keyword, or SKU (typed or scanned).
    public var query = ""
    public var newItemTitle: String

    /// The shared listing, when the share named one.
    public let listing: ListingURL?

    private let service: any ListingLinkService
    private let makeIdempotencyKey: @Sendable () -> String
    /// One key per confirmed action, reused by every retry of it.
    private var idempotencyKey: String?

    public init(
        content: SharedContent,
        service: any ListingLinkService,
        makeIdempotencyKey: @escaping @Sendable () -> String = { UUID().uuidString },
    ) {
        self.service = service
        self.makeIdempotencyKey = makeIdempotencyKey
        newItemTitle = content.suggestedTitle ?? ""
        switch content.listingParse {
        case let .listing(listing):
            self.listing = listing
            phase = service.isSignedIn() ? .choosing : .signedOut
        case let .notListing(marketplace):
            listing = nil
            phase = .unsupported(
                title: "Not a listing",
                message: "This is a \(marketplace.displayName) page, not a single listing. "
                    + "Open the listing itself and share it again.",
            )
        case .unsupported:
            listing = nil
            phase = .unsupported(
                title: "Not a marketplace listing",
                message: "Listora links listings from eBay, Depop, Poshmark, and Mercari. "
                    + "Share a listing from one of them.",
            )
        }
    }

    /// Searches for `query` and shows the results, unless the query changed meanwhile.
    public func search() async {
        guard phase == .choosing else { return }
        let searched = query
        searchState = .searching
        do {
            let found = try await service.searchItems(searched)
            guard searched == query else { return }
            results = found
            searchState = .loaded
        } catch {
            guard searched == query else { return }
            if error.isUnauthenticated {
                phase = .signedOut
                return
            }
            searchState = .failed(error)
        }
    }

    /// Why the item cannot take this listing, or nil when it can.
    public func unavailableReason(for item: ItemMatch) -> String? {
        guard let listing else { return nil }
        if !item.acceptsLinks {
            return "Sold or archived"
        }
        if item.liveMarketplaces.contains(listing.marketplace.rawValue) {
            return "Already listed on \(listing.marketplace.displayName)"
        }
        return nil
    }

    public func choose(_ item: ItemMatch) {
        guard unavailableReason(for: item) == nil else { return }
        review(.existing(item))
    }

    /// The trimmed new-item title, or nil while it is blank.
    public var validNewItemTitle: String? {
        let title = newItemTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? nil : String(title.prefix(SharedContent.maxTitleLength))
    }

    public func chooseNewItem() {
        guard let title = validNewItemTitle else { return }
        review(.newItem(title: title))
    }

    /// Back from the review or a failure to choosing another item.
    public func back() {
        switch phase {
        case .confirming, .failed:
            idempotencyKey = nil
            phase = .choosing
        case .unsupported, .signedOut, .choosing, .submitting, .linked:
            break
        }
    }

    /// Records the reviewed link.
    public func confirm() async {
        guard case let .confirming(target) = phase else { return }
        await submit(target)
    }

    /// Sends the failed link again with the same Idempotency-Key, so it is recorded at most once.
    public func retry() async {
        guard case let .failed(target, error) = phase, error.retryable else { return }
        await submit(target)
    }

    private func review(_ target: Target) {
        idempotencyKey = makeIdempotencyKey()
        phase = .confirming(target)
    }

    private func submit(_ target: Target) async {
        guard let listing, let key = idempotencyKey else { return }
        phase = .submitting(target)
        do {
            let linked = switch target {
            case let .existing(item):
                try await service.link(listing, to: item, idempotencyKey: key)
            case let .newItem(title):
                try await service.importListing(listing, title: title, idempotencyKey: key)
            }
            phase = .linked(linked)
        } catch {
            phase = error.isUnauthenticated ? .signedOut : .failed(target, error)
        }
    }
}
