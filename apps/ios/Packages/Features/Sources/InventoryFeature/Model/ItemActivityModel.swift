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

/// One activity line as the screen shows it: the server's words, who did it, when, how long it
/// took, and a browser session's steps.
struct ActivityRowContent: Equatable, Identifiable {
    struct Step: Equatable, Hashable {
        let name: String
        let duration: String?
    }

    let id: String
    let title: String
    let detail: String?
    let date: Date
    let source: String
    let tone: StatusTone
    let systemImage: String
    let duration: String?
    let steps: [Step]

    init(_ entry: ActivityEntry) {
        id = entry.id
        title = entry.title
        detail = entry.detail
        date = entry.at
        source = Self.source(entry)
        tone = Self.tone(entry.outcome)
        systemImage = Self.systemImage(entry)
        duration = entry.durationMs.map { Self.duration(milliseconds: Int($0)) }
        steps = (entry.steps ?? []).map { step in
            Step(name: step.name, duration: step.durationMs.map { Self.duration(milliseconds: Int($0)) })
        }
    }

    /// Who did it, in the seller's words.
    private static func source(_ entry: ActivityEntry) -> String {
        switch entry.source.value1 {
        case .iphone: "On your iPhone"
        case .cloudBrowser: "Listora's cloud browser"
        case .you: "You"
        case .marketplace: entry.marketplace.map { marketplaceName($0) } ?? "The marketplace"
        case .listora, nil: "Listora"
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
        case .browserSession: entry.source.value1 == .iphone ? "iphone" : "globe"
        case .saleCheck: "magnifyingglass"
        case .order: "doc.text"
        case .sale: "dollarsign.circle"
        case .delist: "tag.slash"
        case .task: "person.crop.circle.badge.exclamationmark"
        case .operation: "arrow.triangle.2.circlepath"
        case .item, nil: "pencil"
        }
    }

    /// "850 ms", "12.3 s", "2 min 5 s".
    static func duration(milliseconds: Int) -> String {
        if milliseconds < 1000 {
            return "\(milliseconds) ms"
        }
        if milliseconds < 60000 {
            return (Double(milliseconds) / 1000).formatted(.number.precision(.fractionLength(1))) + " s"
        }
        let seconds = (milliseconds + 500) / 1000
        return "\(seconds / 60) min \(seconds % 60) s"
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
