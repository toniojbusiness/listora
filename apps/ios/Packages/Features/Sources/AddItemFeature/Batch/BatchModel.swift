import APIClient
import Core
import Foundation
import ListoraAPI
import Observation
import os

/// How often the batch screen asks the server where its items are, and how long an item may stay
/// in one waiting state before the screen offers Retry. Every wait ends.
struct BatchTiming: Sendable {
    var pollInterval: Duration = .seconds(2)
    /// An item analyzing longer than this offers Retry (submits it again).
    var analysisDeadline: TimeInterval = 5 * 60

    static let standard = BatchTiming()
}

/// Reads a batch from the server; a protocol so the batch screen's tests run against a fake.
protocol BatchProgressSource: Sendable {
    func batch(id: String) async throws(APIFailure) -> ItemBatch
}

extension UploadAPI: BatchProgressSource {
    func batch(id: String) async throws(APIFailure) -> ItemBatch {
        try await itemBatch(id: id)
    }
}

/// One item of a batch as its screen shows it: its local upload until the server has every photo,
/// then the server's own status, word for word.
struct BatchItemRow: Equatable, Identifiable {
    enum Tone: Equatable {
        case success
        case inProgress
        case actionNeeded
        case failed
        case neutral
    }

    /// What the seller can do about the item.
    enum Action: Equatable {
        /// Upload again: retries stopped on this iPhone.
        case retryUpload(draftID: String)
        /// Ask the server again (the analysis failed or could not start).
        case resubmit(draftID: String)
        /// A photo has to change: open the draft's photos.
        case editPhotos(draftID: String)
    }

    let id: String
    let position: Int
    let title: String
    let status: String
    let detail: String?
    let tone: Tone
    let action: Action?
    /// A local photo file to show, while the draft is on this iPhone.
    let coverFile: URL?
    /// The server's thumbnail once the draft has left this iPhone.
    let coverURL: URL?
    /// The server item, once it exists.
    let itemID: String?
    let sku: String?
    let draftID: String?
    /// Analyzed: the review shows its details at once.
    let isAnalyzed: Bool
    /// Ready for the rapid review: analyzed, or analyzing (the review waits for it).
    let isReviewable: Bool
    let isSaved: Bool
}

@MainActor
@Observable
final class BatchModel {
    let batchID: String
    let store: DraftStore
    let uploader: PhotoUploader
    let activity: UploadActivity
    let meter: InteractionMeter
    private let source: any BatchProgressSource
    private let timing: BatchTiming
    private let now: () -> Date
    private let log = Logger(subsystem: "com.listora.app", category: "batch")

    private(set) var batch: Batch?
    /// The batch was deleted, or it finished and left this iPhone.
    private(set) var isGone = false
    private(set) var server: ItemBatch?
    /// The last server read failed: why. The screen keeps asking.
    private(set) var serverProblem: String?
    /// When each server item was first seen analyzing, for its deadline.
    private var analyzingSince: [String: Date] = [:]
    var errorMessage: String?

    init(
        batchID: String,
        store: DraftStore,
        uploader: PhotoUploader,
        activity: UploadActivity,
        meter: InteractionMeter,
        source: any BatchProgressSource,
        timing: BatchTiming = .standard,
        now: @escaping () -> Date = Date.init,
    ) {
        self.batchID = batchID
        self.store = store
        self.uploader = uploader
        self.activity = activity
        self.meter = meter
        self.source = source
        self.timing = timing
        self.now = now
    }

    // MARK: Reading

    /// Keeps ``batch`` current until the calling task is cancelled.
    func observe() async {
        do {
            for try await batch in store.observeBatch(id: batchID) {
                self.batch = batch
                if batch == nil {
                    isGone = true
                }
            }
        } catch {
            log.error("Observing a batch failed: \(String(describing: error), privacy: .public)")
        }
    }

    /// Reads the server batch every ``BatchTiming/pollInterval`` until the calling task is
    /// cancelled (the screen went away).
    func poll() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(for: timing.pollInterval)
        }
    }

    func refresh() async {
        guard let serverBatchID = batch?.record.serverBatchID else { return }
        do {
            let server = try await source.batch(id: serverBatchID)
            self.server = server
            serverProblem = nil
            let time = now()
            let analyzing = Set(server.items.filter { Self.isWaiting($0) }.map(\.item.id))
            analyzingSince = analyzingSince.filter { analyzing.contains($0.key) }
            for id in analyzing where analyzingSince[id] == nil {
                analyzingSince[id] = time
            }
        } catch {
            serverProblem = "Listora couldn't check on this batch: \(error.message)"
        }
    }

    private static func isWaiting(_ item: ItemBatchItem) -> Bool {
        switch item.state.value1 {
        case .preparingPhotos?, .analyzing?: true
        default: false
        }
    }

    // MARK: Rows

    /// Every item, confirmed on this iPhone or on the server, in haul order.
    var rows: [BatchItemRow] {
        guard let batch else { return [] }
        let serverItems = server?.items ?? []
        let serverByID = Dictionary(serverItems.map { ($0.item.id, $0) }) { first, _ in first }
        var rows: [BatchItemRow] = []
        var shown = Set<String>()
        for draft in batch.drafts {
            let serverItem = draft.record.serverItemID.flatMap { serverByID[$0] }
            if let id = draft.record.serverItemID {
                shown.insert(id)
            }
            rows.append(row(draft: draft, serverItem: serverItem))
        }
        // Items saved from this batch have left this iPhone; the server still lists them.
        for item in serverItems where !shown.contains(item.item.id) {
            rows.append(row(serverItem: item))
        }
        return rows.sorted { $0.position < $1.position }
    }

    var reviewableRows: [BatchItemRow] {
        rows.filter(\.isReviewable)
    }

    var savedCount: Int {
        rows.count(where: \.isSaved)
    }

    /// The rapid review of every item the server has analyzed, or is analyzing, in haul order.
    var reviewRequest: BatchReviewRequest? {
        guard let serverBatchID = batch?.record.serverBatchID else { return nil }
        let items = rows.filter(\.isReviewable).compactMap { row -> BatchReviewRequest.Item? in
            guard let itemID = row.itemID else { return nil }
            return BatchReviewRequest.Item(sessionID: row.draftID ?? itemID, itemID: itemID, sku: row.sku)
        }
        guard !items.isEmpty else { return nil }
        return BatchReviewRequest(
            batchID: serverBatchID,
            items: items,
            batchSessionID: BatchRecord.meterSession(batchID),
        )
    }

    private func row(draft: Draft, serverItem: ItemBatchItem?) -> BatchItemRow {
        let summary = DraftUploadSummary(
            draft: draft,
            transferring: activity.transferring,
            isSignedIn: activity.isSignedIn,
        )
        let position = draft.record.batchPosition ?? 0
        let title = draft.record.sku ?? "Item \(position + 1)"
        let submitted = draft.record.submittedPhotoIDs != nil
        guard summary.isComplete, submitted, let serverItem else {
            return BatchItemRow(
                id: draft.id,
                position: position,
                title: title,
                status: summary.isComplete ? "Saved to Listora" : summary.badge,
                detail: summary.tone == .danger ? summary.text : nil,
                tone: Self.tone(summary.tone),
                action: summary.canRetry ? .retryUpload(draftID: draft.id) : nil,
                coverFile: draft.photos.first.map(store.fileURL(for:)),
                coverURL: nil,
                itemID: draft.record.serverItemID,
                sku: draft.record.sku,
                draftID: draft.id,
                isAnalyzed: false,
                isReviewable: false,
                isSaved: false,
            )
        }
        return row(serverItem: serverItem, draft: draft)
    }

    private func row(serverItem: ItemBatchItem, draft: Draft? = nil) -> BatchItemRow {
        let state = serverItem.state.value1
        let draftID = draft?.id
        var tone = Self.tone(serverItem.statusDisplay.tone)
        var status = serverItem.statusDisplay.label
        var detail = serverItem.statusDisplay.detail
        var action: BatchItemRow.Action?
        if state == .failed, let draftID {
            action = serverItem.problem?.code == "photo_failed" || serverItem.problem?.retryable == false
                ? .editPhotos(draftID: draftID)
                : .resubmit(draftID: draftID)
        } else if Self.isWaiting(serverItem), let draftID, let since = analyzingSince[serverItem.item.id],
                  now().timeIntervalSince(since) > timing.analysisDeadline
        {
            // Still not done after the deadline: say so, and let the seller ask again.
            tone = .actionNeeded
            status = "Taking longer than usual - Retry"
            detail = "Listora is still working on this item. Ask again if it doesn't finish."
            action = .resubmit(draftID: draftID)
        }
        return BatchItemRow(
            id: draftID ?? serverItem.item.id,
            position: Int(serverItem.position),
            title: serverItem.item.sku,
            status: status,
            detail: detail,
            tone: tone,
            action: action,
            coverFile: draft?.photos.first.map(store.fileURL(for:)),
            coverURL: (serverItem.item.coverPhoto?.urls?.thumbnail).flatMap { URL(string: $0) },
            itemID: serverItem.item.id,
            sku: serverItem.item.sku,
            draftID: draftID,
            isAnalyzed: state == .readyForReview,
            isReviewable: state == .readyForReview || (Self.isWaiting(serverItem) && draftID != nil),
            isSaved: state == .saved,
        )
    }

    private static func tone(_ tone: DraftUploadSummary.Tone) -> BatchItemRow.Tone {
        switch tone {
        case .success: .inProgress
        case .neutral: .inProgress
        case .empty: .neutral
        case .warning: .actionNeeded
        case .danger: .failed
        }
    }

    private static func tone(_ tone: Components.Schemas.StatusTone) -> BatchItemRow.Tone {
        switch tone.value1 {
        case .success: .success
        case .inProgress, .checking: .inProgress
        case .actionNeeded: .actionNeeded
        case .failed: .failed
        case .neutral, nil: .neutral
        }
    }

    // MARK: Actions

    func perform(_ action: BatchItemRow.Action) {
        do {
            switch action {
            case let .retryUpload(draftID):
                try store.retry(draftID: draftID)
            case let .resubmit(draftID):
                try store.updateDraft(draftID) { record in
                    record.submittedPhotoIDs = nil
                    record.retry = RetryState()
                }
            case .editPhotos:
                return
            }
        } catch {
            errorMessage = "Listora couldn't save that on this iPhone. Try again."
            return
        }
        let uploader = uploader
        Task { await uploader.wake() }
    }

    /// Deletes the batch from this iPhone and its items from Listora (the upload queue removes
    /// the server items); items already saved stay in the inventory.
    func deleteBatch() {
        do {
            let photos = try store.deleteBatch(batchID)
            let uploader = uploader
            Task {
                await uploader.cancelTransfers(of: photos.map(\.id))
                await uploader.wake()
            }
            meter.discard(BatchRecord.meterSession(batchID))
        } catch {
            errorMessage = "Listora couldn't delete this batch. Try again."
        }
    }
}
