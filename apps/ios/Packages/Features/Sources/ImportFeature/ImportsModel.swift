import APIClient
import Core
import DesignSystem
import Foundation
import ListoraAPI
import Observation

/// One marketplace on the Import listings screen: whether an import can start, and its newest
/// import in the server's words ("Reading your Depop listings on your iPhone... 48 so far",
/// "Imported 42 from Depop, 3 need you").
public struct ImportRow: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let marketplace: Components.Schemas.KnownMarketplace?
    public let canStart: Bool
    /// Why an import can't start, when it can't.
    public let unavailableReason: String?
    /// The newest import, when there is one.
    public let latest: Latest?

    public struct Latest: Equatable, Sendable {
        public let importID: String
        /// Pages are still being read, or listings still turned into items.
        public let isRunning: Bool
        public let progress: String
        public let summary: String?
        public let stoppedReason: String?
        public let needsYou: Int
        public let failed: Int
    }

    init(_ entry: Components.Schemas.ListingImportMarketplace) {
        let id = entry.marketplace.value1?.rawValue ?? entry.marketplace.value2 ?? ""
        self.id = id
        name = ImportRow.name(of: id)
        marketplace = entry.marketplace.value1
        canStart = entry.canStart
        unavailableReason = entry.unavailableReason
        latest = entry.latest.map(Latest.init)
    }

    static func name(of id: String) -> String {
        switch id {
        case "depop": "Depop"
        case "poshmark": "Poshmark"
        case "mercari": "Mercari"
        case "ebay": "eBay"
        default: id.capitalized
        }
    }

    /// What the row's button does: start an import, or start one again.
    public var startTitle: String {
        latest == nil ? "Import from \(name)" : "Import again"
    }
}

extension ImportRow.Latest {
    init(_ listingImport: Components.Schemas.ListingImport) {
        importID = listingImport.id
        isRunning = listingImport.status.value1 != .finished
        progress = listingImport.progress
        summary = listingImport.summary
        stoppedReason = listingImport.stoppedReason
        needsYou = Int(listingImport.counts.needsYou)
        failed = Int(listingImport.counts.failed)
    }

    /// How the import is doing, as a badge: still going, waiting for the seller, or done.
    var tone: StatusTone {
        if isRunning {
            return .inProgress
        }
        if needsYou > 0 {
            return .actionNeeded
        }
        if stoppedReason != nil || failed > 0 {
            return .failed
        }
        return .success
    }
}

/// The Import listings screen (docs/features/imports.md): each marketplace Listora imports from,
/// starting an import, and its progress while it runs. Every word about an import is the
/// server's; the app only reads it again (every few seconds while one runs, and whenever the
/// phone finishes a run of marketplace work, since a marketplace that runs on this iPhone reads
/// its pages here).
@MainActor
@Observable
public final class ImportsModel {
    public enum Phase: Equatable {
        case loading
        case loaded
        /// The list could not be loaded; `message` is safe to show.
        case failed(message: String)
    }

    public struct Notice: Equatable, Sendable {
        public let message: String
        public let tone: StatusTone
    }

    public private(set) var rows: [ImportRow] = []
    public private(set) var phase: Phase = .loading
    public private(set) var notice: Notice?
    /// The marketplace whose import is being started right now.
    public private(set) var starting: String?
    /// Runs the work waiting for this phone (an import page of a marketplace that runs here).
    public weak var phoneWork: (any PhoneWorkTrigger)?

    private let service: any ImportsService
    private let pollInterval: Duration
    private let sleep: @Sendable (Duration) async throws -> Void
    /// The key of a start whose answer was lost, sent again with it so it starts once.
    private var pendingStart: (marketplace: String, key: String)?

    public init(
        service: any ImportsService,
        pollInterval: Duration = .seconds(3),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
    ) {
        self.service = service
        self.pollInterval = pollInterval
        self.sleep = sleep
    }

    /// Whether an import is still reading or importing.
    public var isRunning: Bool {
        rows.contains { $0.latest?.isRunning == true }
    }

    /// Loads (or reloads) every marketplace and its newest import.
    public func load() async {
        if rows.isEmpty {
            phase = .loading
        }
        do {
            rows = try await service.marketplaces().map(ImportRow.init)
            phase = .loaded
        } catch {
            phase = .failed(message: error.isUnauthenticated ? "Sign in to import your listings." : error.message)
        }
    }

    /// Loads, then reads again every few seconds while an import runs, until the task ends.
    public func watch() async {
        await load()
        while isRunning {
            do {
                try await sleep(pollInterval)
            } catch {
                return
            }
            await load()
        }
    }

    /// Starts importing `row`'s listings; the phone then reads its pages, if it runs here.
    public func start(_ row: ImportRow) async {
        guard let marketplace = row.marketplace, starting == nil else { return }
        starting = row.id
        defer { starting = nil }
        let key = pendingStart?.marketplace == row.id ? pendingStart?.key ?? UUID().uuidString : UUID().uuidString
        pendingStart = (row.id, key)
        do {
            _ = try await service.start(marketplace: marketplace, idempotencyKey: key)
            pendingStart = nil
            notice = Notice(
                message: "Listora is reading your \(row.name) listings. It changes nothing on \(row.name).",
                tone: .inProgress,
            )
            phoneWork?.runPhoneWork(.userAction)
        } catch {
            if error.retryable == false {
                pendingStart = nil
            }
            notice = Notice(message: error.message, tone: .failed)
        }
        await load()
    }

    public func dismissNotice() {
        notice = nil
    }
}
