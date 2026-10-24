import APIClient
import Core
import Foundation
import ShareLinkFeature
import Synchronization
import Testing

@MainActor
struct ShareLinkModelTests {
    private let poshmark = SharedContent(
        urls: [URL(string: "https://poshmark.com/listing/Lululemon-Align-Pant-25-64f1a2b3c4d5e6f7a8b9c0d1")!],
        title: "Lululemon Align Pant 25 | Poshmark",
    )
    private let pant = ItemMatch(id: "item-1", sku: "AJ-000184", title: "Lululemon Align pant", brand: "Lululemon")
    private let confirmed = LinkedListing(
        itemSKU: "AJ-000184",
        itemTitle: "Lululemon Align pant",
        statusLabel: "Active (you confirmed)",
        statusTone: .success,
    )

    private func model(_ service: FakeLinkService, content: SharedContent? = nil) -> ShareLinkModel {
        let counter = Mutex(0)
        return ShareLinkModel(content: content ?? poshmark, service: service) {
            counter.withLock { count in
                count += 1
                return "key-\(count)"
            }
        }
    }

    @Test
    func `explains a share that is not a listing, naming the marketplace page`() throws {
        let closet = try model(
            FakeLinkService(),
            content: SharedContent(urls: [#require(URL(string: "https://poshmark.com/closet/jane"))]),
        )
        #expect(closet.phase == .unsupported(
            title: "Not a listing",
            message: "This is a Poshmark page, not a single listing. Open the listing itself and share it again.",
        ))
        #expect(closet.listing == nil)

        let other = model(FakeLinkService(), content: SharedContent(text: "hello"))
        guard case let .unsupported(title, _) = other.phase else {
            Issue.record("expected unsupported, got \(other.phase)")
            return
        }
        #expect(title == "Not a marketplace listing")
    }

    @Test
    func `asks the user to sign in in the app when there is no session`() {
        #expect(model(FakeLinkService(signedIn: false)).phase == .signedOut)
    }

    @Test
    func `shows the shared listing and suggests a title for a new item`() {
        let model = model(FakeLinkService())
        #expect(model.phase == .choosing)
        #expect(model.listing?.marketplace == .poshmark)
        #expect(model.listing?.listingId == "64f1a2b3c4d5e6f7a8b9c0d1")
        #expect(model.newItemTitle == "Lululemon Align Pant 25")
    }

    @Test
    func `searches and shows the results`() async {
        let service = FakeLinkService(items: [pant])
        let model = model(service)
        model.query = "lulu"
        await model.search()
        #expect(model.results == [pant])
        #expect(model.searchState == .loaded)
        #expect(service.searches == ["lulu"])
    }

    @Test
    func `shows a failed search with its message, and a lost session as signed out`() async {
        let offline = APIFailure.networkUnavailable
        let model = model(FakeLinkService(searchError: offline))
        await model.search()
        #expect(model.searchState == .failed(offline))

        let expired = APIFailure(statusCode: 401, code: "unauthenticated", message: "Sign in again.", retryable: false)
        let signedOut = self.model(FakeLinkService(searchError: expired))
        await signedOut.search()
        #expect(signedOut.phase == .signedOut)
    }

    @Test
    func `offers only items that can take the listing`() {
        let model = model(FakeLinkService())
        let listedThere = ItemMatch(id: "2", sku: "AJ-000185", liveMarketplaces: ["poshmark"])
        let listedElsewhere = ItemMatch(id: "3", sku: "AJ-000186", liveMarketplaces: ["ebay"])
        let sold = ItemMatch(id: "4", sku: "AJ-000187", acceptsLinks: false)

        #expect(model.unavailableReason(for: listedThere) == "Already listed on Poshmark")
        #expect(model.unavailableReason(for: listedElsewhere) == nil)
        #expect(model.unavailableReason(for: sold) == "Sold or archived")

        model.choose(listedThere)
        #expect(model.phase == .choosing)
        model.choose(listedElsewhere)
        #expect(model.phase == .confirming(.existing(listedElsewhere)))
    }

    @Test
    func `links the chosen item after the user confirms and shows what the server recorded`() async {
        let service = FakeLinkService(results: [.success(confirmed)])
        let model = model(service)
        model.choose(pant)
        #expect(model.phase == .confirming(.existing(pant)))
        #expect(service.calls.isEmpty, "nothing is recorded before the user confirms")

        await model.confirm()

        #expect(model.phase == .linked(confirmed))
        #expect(service.calls == [.link(
            url: "https://poshmark.com/listing/Lululemon-Align-Pant-25-64f1a2b3c4d5e6f7a8b9c0d1",
            itemId: "item-1",
            key: "key-1",
        )])
    }

    @Test
    func `retries a failed link with the same Idempotency-Key`() async {
        let timeout = APIFailure.networkUnavailable
        let service = FakeLinkService(results: [.failure(timeout), .success(confirmed)])
        let model = model(service)
        model.choose(pant)
        await model.confirm()
        #expect(model.phase == .failed(.existing(pant), timeout))

        await model.retry()

        #expect(model.phase == .linked(confirmed))
        #expect(service.calls.map(\.key) == ["key-1", "key-1"])
    }

    @Test
    func `does not retry a refused link; choosing again starts a new action`() async {
        let duplicate = APIFailure(
            statusCode: 409,
            code: "already_exists",
            message: "This Poshmark listing is already linked to AJ-000101.",
            retryable: false,
        )
        let service = FakeLinkService(results: [.failure(duplicate), .success(confirmed)])
        let model = model(service)
        model.choose(pant)
        await model.confirm()
        #expect(model.phase == .failed(.existing(pant), duplicate))

        await model.retry()
        #expect(service.calls.count == 1)

        model.back()
        #expect(model.phase == .choosing)
        model.choose(pant)
        await model.confirm()
        #expect(model.phase == .linked(confirmed))
        #expect(service.calls.map(\.key) == ["key-1", "key-2"])
    }

    @Test
    func `a lost session while linking asks the user to sign in`() async {
        let expired = APIFailure(statusCode: 401, code: "unauthenticated", message: "Sign in again.", retryable: false)
        let model = model(FakeLinkService(results: [.failure(expired)]))
        model.choose(pant)
        await model.confirm()
        #expect(model.phase == .signedOut)
    }

    @Test
    func `creates a placeholder item with the confirmed title`() async {
        let created = LinkedListing(
            itemSKU: "AJ-000190",
            itemTitle: "Align pant",
            statusLabel: "Active (you confirmed)",
            statusTone: .success,
        )
        let service = FakeLinkService(results: [.success(created)])
        let model = model(service)

        model.newItemTitle = "   "
        #expect(model.validNewItemTitle == nil)
        model.chooseNewItem()
        #expect(model.phase == .choosing)

        model.newItemTitle = "  Align pant "
        model.chooseNewItem()
        #expect(model.phase == .confirming(.newItem(title: "Align pant")))
        await model.confirm()

        #expect(model.phase == .linked(created))
        #expect(service.calls == [.importListing(
            url: "https://poshmark.com/listing/Lululemon-Align-Pant-25-64f1a2b3c4d5e6f7a8b9c0d1",
            title: "Align pant",
            key: "key-1",
        )])
    }
}

/// Records calls and answers them from a script.
final class FakeLinkService: ListingLinkService {
    enum Call: Equatable {
        case link(url: String, itemId: String, key: String)
        case importListing(url: String, title: String, key: String)

        var key: String {
            switch self {
            case let .link(_, _, key), let .importListing(_, _, key): key
            }
        }
    }

    private struct State {
        var searches: [String] = []
        var calls: [Call] = []
        var results: [Result<LinkedListing, APIFailure>]
    }

    private let signedIn: Bool
    private let items: [ItemMatch]
    private let searchError: APIFailure?
    private let state: Mutex<State>

    init(
        signedIn: Bool = true,
        items: [ItemMatch] = [],
        searchError: APIFailure? = nil,
        results: [Result<LinkedListing, APIFailure>] = [],
    ) {
        self.signedIn = signedIn
        self.items = items
        self.searchError = searchError
        state = Mutex(State(results: results))
    }

    var searches: [String] {
        state.withLock { $0.searches }
    }

    var calls: [Call] {
        state.withLock { $0.calls }
    }

    func isSignedIn() -> Bool {
        signedIn
    }

    func searchItems(_ query: String) async throws(APIFailure) -> [ItemMatch] {
        state.withLock { $0.searches.append(query) }
        if let searchError {
            throw searchError
        }
        return items
    }

    func link(
        _ listing: ListingURL,
        to item: ItemMatch,
        idempotencyKey: String,
    ) async throws(APIFailure) -> LinkedListing {
        try answer(.link(url: listing.canonicalURL.absoluteString, itemId: item.id, key: idempotencyKey))
    }

    func importListing(_ listing: ListingURL, title: String, idempotencyKey: String) async throws(APIFailure)
        -> LinkedListing
    {
        try answer(.importListing(url: listing.canonicalURL.absoluteString, title: title, key: idempotencyKey))
    }

    private func answer(_ call: Call) throws(APIFailure) -> LinkedListing {
        let result = state.withLock { state in
            state.calls.append(call)
            return state.results.isEmpty ? nil : state.results.removeFirst()
        }
        guard let result else {
            throw APIFailure(statusCode: 500, code: "internal_error", message: "No scripted answer.", retryable: false)
        }
        return try result.get()
    }
}
