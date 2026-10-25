import Core
import Foundation
import Observation
import os

/// One batch capture session: every photo is saved to the batch on the device as it is taken, its
/// grouping signals are read in the background, and the photos taken so far are grouped again
/// after each read, so the camera shows which item the seller is on and when Listora saw a new
/// one. The grouping the seller confirms is made from the saved photos when the session ends.
@MainActor
@Observable
final class BatchCaptureModel {
    struct Shot: Equatable, Identifiable {
        let record: BatchShotRecord
        let fileURL: URL

        var id: String {
            record.id
        }
    }

    let batchID: String
    private let store: DraftStore
    private let reader: any PhotoSignalReader
    private let now: () -> Date
    private let log = Logger(subsystem: "com.listora.app", category: "batch")

    /// This session's photos, in capture order.
    private(set) var shots: [Shot] = []
    /// Signals read so far, by photo.
    private var signals: [String: ShotSignals] = [:]
    /// Items the batch had before this session (confirmed, or waiting to be confirmed).
    private let itemsBefore: Int
    /// The next photo starts a new item: the seller tapped Next item, or this session continues a
    /// batch that already has items.
    private(set) var nextStartsNewItem: Bool
    /// The photo whose reading showed it starts a new item, for the "New item" notice.
    private(set) var detectedNewItemAt: String?
    /// Reads still running; ``finish()`` waits for them so the grouping has every signal.
    private var reads: [String: Task<Void, Never>] = [:]
    /// The live grouping of this session's photos.
    private var stacks: [ProposedStack] = []

    init(
        batchID: String,
        store: DraftStore,
        reader: any PhotoSignalReader,
        itemsBefore: Int,
        now: @escaping () -> Date = Date.init,
    ) {
        self.batchID = batchID
        self.store = store
        self.reader = reader
        self.itemsBefore = itemsBefore
        self.now = now
        nextStartsNewItem = itemsBefore > 0
    }

    /// The item the seller is shooting, 1 first, counting the batch's earlier items.
    var itemNumber: Int {
        itemsBefore + max(stacks.count, 1) + (nextStartsNewItem && !shots.isEmpty ? 1 : 0)
    }

    /// Photos of the current item so far.
    var photosInItem: Int {
        nextStartsNewItem ? 0 : stacks.last?.shotIDs.count ?? 0
    }

    /// Items this session has photos of.
    var itemCount: Int {
        stacks.count
    }

    var canStartNextItem: Bool {
        !shots.isEmpty && !nextStartsNewItem
    }

    var lastShot: Shot? {
        shots.last
    }

    /// Saves a prepared photo to the batch and starts reading its signals.
    func add(_ photo: PreparedPhoto) throws {
        let record = try store.addShot(
            photo,
            to: batchID,
            capturedAt: now(),
            startsNewItem: nextStartsNewItem,
        )
        nextStartsNewItem = false
        shots.append(Shot(record: record, fileURL: store.fileURL(for: record)))
        regroup()
        let reader = reader
        let data = photo.data
        reads[record.id] = Task { [weak self] in
            let read: ShotSignals?
            do {
                read = try await reader.signals(of: data)
            } catch {
                self?.log.error("Reading a batch photo failed: \(String(describing: error), privacy: .public)")
                read = nil
            }
            self?.record(read, for: record.id)
        }
    }

    /// The seller tapped Next item: the next photo starts a new item.
    func startNextItem() {
        guard canStartNextItem else { return }
        nextStartsNewItem = true
        detectedNewItemAt = nil
    }

    /// Removes the last photo (Retake, or the thumbnail's remove button).
    func removeLast() {
        guard let last = shots.popLast() else { return }
        reads.removeValue(forKey: last.id)?.cancel()
        signals[last.id] = nil
        if detectedNewItemAt == last.id {
            detectedNewItemAt = nil
        }
        do {
            try store.deleteShot(last.id)
        } catch {
            log.error("Removing a batch photo failed: \(String(describing: error), privacy: .public)")
        }
        regroup()
    }

    /// Removes every photo of this session (the seller discarded them).
    func discardAll() {
        while !shots.isEmpty {
            removeLast()
        }
    }

    /// Waits for every signal read, then groups the session's photos for the seller to confirm.
    func finish() async throws {
        for read in reads.values {
            await read.value
        }
        reads = [:]
        try store.groupUngroupedShots(in: batchID)
    }

    private func record(_ read: ShotSignals?, for shotID: String) {
        reads[shotID] = nil
        guard shots.contains(where: { $0.id == shotID }) else { return }
        if let read {
            signals[shotID] = read
        }
        do {
            try store.recordSignals(read, of: shotID)
        } catch {
            log.error("Saving a batch photo's signals failed: \(String(describing: error), privacy: .public)")
        }
        let before = stacks.count
        regroup()
        // Listora saw a new item on its own: say so once, on that photo.
        if stacks.count > before, let first = stacks.last?.shotIDs.first,
           shots.first(where: { $0.id == first })?.record.startsNewItem == false
        {
            detectedNewItemAt = first
        }
    }

    /// Groups the photos whose signals are in; a photo still being read joins the item before it
    /// for now, so the count never jumps ahead of what Listora has seen.
    private func regroup() {
        let known = shots.map { shot in
            BatchShot(
                id: shot.id,
                capturedAt: shot.record.capturedAt,
                signals: signals[shot.id] ?? (reads[shot.id] == nil ? nil : Self.unread),
                startsNewItem: shot.record.startsNewItem,
            )
        }
        stacks = BatchGrouper.group(known)
    }

    /// Stands in for a photo still being read: it looks like a tag, so it joins the item before.
    private static let unread = ShotSignals(featurePrint: nil, tagLikelihood: 1)
}
