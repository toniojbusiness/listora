import APIClient
import DesignSystem
import Foundation
import ListoraAPI
import Observation

/// The item's activity (docs/features/activity.md): everything that happened to it, newest first,
/// in the server's words. A page at a time; the screen asks for more at the end of the list.
@MainActor
@Observable
final class ItemActivityModel {
    enum Phase: Equatable {
        case loading
        case loaded
        case failed(message: String)
    }

    let itemID: String
    private(set) var rows: [ActivityRowContent] = []
    private(set) var phase: Phase = .loading
    private(set) var isLoadingMore = false
    private var nextCursor: String?
    private let service: any InventoryService

    init(itemID: String, service: any InventoryService) {
        self.itemID = itemID
        self.service = service
    }

    var hasMore: Bool {
        nextCursor != nil
    }

    /// The newest page; a failure keeps what is shown.
    func load() async {
        if rows.isEmpty {
            phase = .loading
        }
        do {
            let page = try await service.activity(itemID: itemID, cursor: nil)
            rows = page.entries.map { ActivityRowContent($0) }
            nextCursor = page.nextCursor
            phase = .loaded
        } catch {
            if rows.isEmpty {
                phase = .failed(message: error.message)
            }
        }
    }

    /// The next, older page, once.
    func loadMore() async {
        guard let cursor = nextCursor, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        guard let page = try? await service.activity(itemID: itemID, cursor: cursor) else { return }
        let known = Set(rows.map(\.id))
        rows += page.entries.filter { !known.contains($0.id) }.map { ActivityRowContent($0) }
        nextCursor = page.nextCursor
    }
}

/// One activity line as the screen shows it: the server's words, who did it, and when. Where
/// Listora ran it and how long it took are Listora's diagnostics, not the seller's.
struct ActivityRowContent: Equatable, Identifiable {
    let id: String
    let title: String
    let detail: String?
    let date: Date
    let source: String
    let tone: StatusTone
    let systemImage: String

    init(_ entry: ActivityEntry) {
        id = entry.id
        title = entry.title
        detail = entry.detail
        date = entry.at
        source = Self.source(entry)
        tone = Self.tone(entry.outcome)
        systemImage = Self.systemImage(entry)
    }

    /// Who did it, in the seller's words.
    private static func source(_ entry: ActivityEntry) -> String {
        switch entry.source.value1 {
        case .you: "You"
        case .marketplace: entry.marketplace.map { marketplaceName($0) } ?? "The marketplace"
        case .listora, .iphone, .cloudBrowser, nil: "Listora"
        }
    }

    /// Only a confirmed outcome looks done.
    private static func tone(_ outcome: Components.Schemas.ActivityOutcome) -> StatusTone {
        switch outcome.value1 {
        case .succeeded: .success
        case .failed: .failed
        case .inProgress: .inProgress
        case .waiting: .actionNeeded
        case .info, nil: .neutral
        }
    }

    private static func systemImage(_ entry: ActivityEntry) -> String {
        switch entry.kind.value1 {
        case .sale: "dollarsign.circle"
        case .delist: "tag.slash"
        case .task: "person.crop.circle.badge.exclamationmark"
        case .operation: "arrow.triangle.2.circlepath"
        case .item, .browserSession, .saleCheck, .order, nil: "pencil"
        }
    }

    private static func marketplaceName(_ marketplace: Components.Schemas.Marketplace) -> String {
        switch marketplace.value1 {
        case .ebay: "eBay"
        case .depop: "Depop"
        case .poshmark: "Poshmark"
        case .mercari: "Mercari"
        case nil: marketplace.value2 ?? "The marketplace"
        }
    }
}
