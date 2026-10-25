import APIClient
import Foundation
import ListoraAPI
import Observation

/// The Inventory tab: the seller's items, newest first, with search and filters. Every load reads
/// the server, so an item saved a moment ago is in the list the next time it appears.
@MainActor
@Observable
final class InventoryListModel {
    enum Phase: Equatable {
        case loading
        case loaded
        /// No session: nothing is asked of the server until the seller signs in.
        case signedOut
        /// The list could not be loaded; `message` is safe to show.
        case failed(message: String)
    }

    /// Changing it reloads the list (the view's `task(id:)`).
    var query = InventoryQuery()
    private(set) var items: [ItemSummary] = []
    private(set) var phase: Phase = .loading
    private(set) var isLoadingMore = false
    /// Every brand seen in the list, for the brand filter.
    private(set) var brands: [String] = []
    private var nextCursor: String?
    private let service: any InventoryService
    private let isSignedIn: @MainActor () -> Bool

    init(service: any InventoryService, isSignedIn: @escaping @MainActor () -> Bool = { true }) {
        self.service = service
        self.isSignedIn = isSignedIn
    }

    var isFiltered: Bool {
        query != InventoryQuery()
    }

    var hasMore: Bool {
        nextCursor != nil
    }

    /// Loads the first page for the current query. Keeps the old rows on screen while it loads.
    func load() async {
        guard isSignedIn() else {
            items = []
            nextCursor = nil
            phase = .signedOut
            return
        }
        let query = query
        if items.isEmpty {
            phase = .loading
        }
        do {
            let page = try await service.items(query, cursor: nil)
            guard query == self.query else { return }
            items = page.items
            nextCursor = page.nextCursor
            remember(brandsOf: page.items)
            phase = .loaded
        } catch {
            guard query == self.query else { return }
            phase = error.isUnauthenticated ? .signedOut : .failed(message: error.message)
        }
    }

    /// The next page, when the last row appears.
    func loadMore() async {
        guard let cursor = nextCursor, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        let query = query
        do {
            let page = try await service.items(query, cursor: cursor)
            guard query == self.query else { return }
            // A set, so the 40th page of a 2,000-item inventory is not checked row by row.
            let shown = Set(items.map(\.id))
            items += page.items.filter { !shown.contains($0.id) }
            nextCursor = page.nextCursor
            remember(brandsOf: page.items)
        } catch {
            // The rows already shown stay; scrolling to the end again tries once more.
        }
    }

    func clearFilters() {
        query = InventoryQuery()
    }

    private func remember(brandsOf items: [ItemSummary]) {
        let seen = Set(brands.map { $0.lowercased() })
        let new = items.compactMap(\.brand).filter { !$0.isEmpty && !seen.contains($0.lowercased()) }
        guard !new.isEmpty else { return }
        var unique: [String] = []
        for brand in new where !unique.contains(where: { $0.lowercased() == brand.lowercased() }) {
            unique.append(brand)
        }
        brands = (brands + unique).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }
}
