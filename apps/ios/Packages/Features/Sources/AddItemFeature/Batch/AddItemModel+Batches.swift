import Core
import Foundation

/// Batch listing in the Add Item tab (docs/features/batch.md): starting a batch from the camera or
/// the library, and what the batch's rapid review reports back.
extension AddItemModel {
    /// The most photos one library import adds to a batch.
    static let maxBatchImport = 200

    /// Keeps ``batches`` current until the calling task is cancelled.
    func observeBatches() async {
        do {
            for try await batches in store.observeBatches() {
                self.batches = batches
            }
        } catch {
            log.error("Observing batches failed: \(String(describing: error), privacy: .public)")
        }
    }

    /// Starts a batch and its interaction measurement (the camera opened, or photos were picked).
    func beginBatch() -> String? {
        do {
            let batch = try store.createBatch()
            meter.begin(batch.meterSession)
            return batch.id
        } catch {
            errorMessage = "Listora couldn't start a batch on this iPhone. Free up some storage and try again."
            return nil
        }
    }

    /// The capture session of a batch, numbering its items after the ones it already has.
    func captureModel(for batchID: String, reader: any PhotoSignalReader) -> BatchCaptureModel {
        let batch = try? store.batch(id: batchID)
        let itemsBefore = (batch?.drafts.count ?? 0) + (batch?.stacks.count ?? 0) +
            ((batch?.ungrouped.isEmpty ?? true) ? 0 : 1)
        return BatchCaptureModel(batchID: batchID, store: store, reader: reader, itemsBefore: itemsBefore)
    }

    /// A batch with no photo and no item left is removed (the seller closed the camera without
    /// shooting, or discarded what they shot).
    func dropBatchIfEmpty(_ batchID: String) {
        guard let batch = try? store.batch(id: batchID), batch.drafts.isEmpty, batch.unconfirmedShotCount == 0,
              batch.record.interaction == nil
        else { return }
        _ = try? store.deleteBatch(batchID)
        meter.discard(batch.record.meterSession)
    }

    /// Adds library photos to a batch, in the order picked, and groups them. Each photo's capture
    /// date (from its EXIF data) is its time; one without keeps the order with a second apart.
    /// Returns the batch's id, or nil when nothing was added.
    func importBatch(_ images: [Data], into existing: String? = nil, reader: any PhotoSignalReader) async -> String? {
        guard !images.isEmpty, let batchID = existing ?? beginBatch() else { return nil }
        let session = BatchRecord.meterSession(batchID)
        meter.setWaiting(true, for: session)
        isPreparingPhotos = true
        defer {
            isPreparingPhotos = false
            meter.setWaiting(false, for: session)
        }
        let store = store
        let start = Date()
        let startsNewItem = existing.flatMap { try? store.batch(id: $0) }
            .map { !$0.drafts.isEmpty || !$0.stacks.isEmpty } ?? false
        let result = await Task.detached(priority: .userInitiated) { () -> Result<Int, any Error> in
            do {
                var added = 0
                for (index, image) in images.enumerated() {
                    let captured = PhotoPreparation.captureDate(of: image) ?? start.addingTimeInterval(Double(index))
                    let photo = try PhotoPreparation.prepare(image)
                    let shot = try store.addShot(
                        photo,
                        to: batchID,
                        capturedAt: captured,
                        startsNewItem: index == 0 && startsNewItem,
                    )
                    let signals = try? await reader.signals(of: photo.data)
                    try store.recordSignals(signals, of: shot.id)
                    added += 1
                }
                try store.groupUngroupedShots(in: batchID)
                return .success(added)
            } catch {
                return .failure(error)
            }
        }.value
        switch result {
        case let .success(added) where added > 0:
            return batchID
        case .success:
            dropBatchIfEmpty(batchID)
            return nil
        case let .failure(error):
            show(error)
            // What was added before the failure stays in the batch, grouped, for the seller to check.
            try? store.groupUngroupedShots(in: batchID)
            dropBatchIfEmpty(batchID)
            return (try? store.batch(id: batchID)) == nil ? nil : batchID
        }
    }

    /// What the rapid review reported: a saved item's draft is done on this iPhone (its server item
    /// lives on), and the batch's measured interaction, the batch's own screens plus every saved
    /// item's review, is kept for the upload queue to send.
    func handle(_ event: BatchReviewEvent, batchID: String) {
        switch event {
        case let .saved(sessionID, itemID, _, summary):
            recordInteraction(of: batchID, adding: summary.map {
                BatchInteraction.Item(
                    serverItemID: itemID,
                    totals: .init(active: $0.active, waiting: $0.waiting, taps: $0.taps),
                )
            })
            completeDraft(sessionID)
        case .finished:
            recordInteraction(of: batchID, adding: nil)
        }
        let uploader = uploader
        Task { await uploader.wake() }
    }

    private func recordInteraction(of batchID: String, adding item: BatchInteraction.Item?) {
        guard let batch = try? store.batch(id: batchID) else { return }
        var items = batch.record.interaction?.items ?? []
        if let item {
            items.removeAll { $0.serverItemID == item.serverItemID }
            items.append(item)
        }
        guard !items.isEmpty else { return }
        let shared = meter.session(batch.record.meterSession).map {
            BatchInteraction.Totals(active: $0.active, waiting: $0.waiting, taps: $0.taps)
        } ?? .zero
        let total = items.reduce(shared) { $0 + $1.totals }
        do {
            try store.setInteraction(BatchInteraction(batch: total, items: items), of: batchID)
        } catch {
            log.error("Saving a batch's interaction failed: \(String(describing: error), privacy: .public)")
        }
    }
}
