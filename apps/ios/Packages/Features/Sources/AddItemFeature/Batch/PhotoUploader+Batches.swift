import APIClient
import Foundation

/// The upload queue's batch steps (``UploadPlanner``): each sends one request, then records the
/// result or the failure.
extension PhotoUploader {
    func perform(_ work: BatchWork, in snapshot: UploadSnapshot) async throws {
        let batches = Dictionary(uniqueKeysWithValues: snapshot.batches.map { ($0.id, $0) })
        let draft = { (id: String) in snapshot.drafts.first { $0.id == id } }
        switch work {
        case let .createBatch(batchID):
            try await createBatch(batches[batchID])
        case let .addItem(draftID):
            let draft = draft(draftID)
            try await addBatchItem(for: draft, in: draft?.batchID.flatMap { batches[$0] })
        case let .submit(draftID):
            if let draft = draft(draftID) {
                try await submit(
                    draft,
                    photos: snapshot.photos.filter { $0.draftID == draftID },
                    in: draft.batchID.flatMap { batches[$0] },
                )
            }
        case let .sendInteraction(batchID):
            try await sendInteraction(of: batches[batchID])
        }
    }

    func recordBatchFailure(_ batchID: String, _ failure: APIFailure) {
        let next = retryUpdate(for: failure, stops: true)
        _ = try? store.updateBatch(batchID) { $0.retry = next($0.retry) }
    }

    func createBatch(_ batch: BatchRecord?) async throws {
        guard let batch else { return }
        let serverBatchID: String
        do {
            serverBatchID = try await api.createItemBatch(idempotencyKey: batch.createBatchKey)
        } catch {
            recordBatchFailure(batch.id, error)
            return
        }
        try store.updateBatch(batch.id) { record in
            record.serverBatchID = serverBatchID
            record.retry = RetryState()
        }
    }

    /// Creates a batch draft's server item at its position. The position, not just the key, is what
    /// the server deduplicates by, so a replay after the key has expired still finds the item.
    func addBatchItem(for draft: DraftRecord?, in batch: BatchRecord?) async throws {
        guard let draft, let serverBatchID = batch?.serverBatchID, let position = draft.batchPosition else { return }
        // Recorded before sending: a draft deleted meanwhile deletes the item the request made.
        guard try store.updateDraft(draft.id, { $0.createItemSent = true }) != nil else { return }
        let item: (id: String, sku: String)
        do {
            item = try await api.addItemBatchItem(
                batchID: serverBatchID,
                position: position,
                idempotencyKey: draft.createItemKey,
            )
        } catch {
            recordDraftFailure(draft.id, error)
            return
        }
        try store.updateDraft(draft.id) { record in
            record.serverItemID = item.id
            record.sku = item.sku
            record.retry = RetryState()
        }
    }

    /// Tells the server every photo of a batch draft is attached, so it analyzes the item.
    func submit(_ draft: DraftRecord, photos: [DraftPhotoRecord], in batch: BatchRecord?) async throws {
        guard let serverBatchID = batch?.serverBatchID, let itemID = draft.serverItemID else { return }
        let photoIDs = photos.compactMap(\.serverPhotoID).sorted()
        let key = draft.submitKey ?? UUID().uuidString.lowercased()
        if draft.submitKey == nil {
            try store.updateDraft(draft.id) { $0.submitKey = key }
        }
        do {
            try await api.submitItemBatchItem(
                batchID: serverBatchID,
                itemID: itemID,
                photoCount: photoIDs.count,
                idempotencyKey: key,
            )
        } catch {
            // A key whose first request had another body: the photos changed after a submit whose
            // answer was lost. The next try sends the new photos with a new key.
            let rotates = error.knownCode == .idempotencyKeyReused
            recordDraftFailure(draft.id, error)
            if rotates {
                try store.updateDraft(draft.id) { $0.submitKey = nil }
            }
            return
        }
        try store.updateDraft(draft.id) { record in
            record.submittedPhotoIDs = photoIDs
            // The next submit (the photos changed) is another request.
            record.submitKey = nil
            record.retry = RetryState()
        }
    }

    /// Sends the batch's measured interaction. It is a measurement, not the seller's work: one the
    /// server refuses for good is dropped rather than retried forever.
    func sendInteraction(of batch: BatchRecord?) async throws {
        guard let batch, let interaction = batch.interaction, let serverBatchID = batch.serverBatchID else { return }
        do {
            try await api.replaceItemBatchInteraction(batchID: serverBatchID, interaction: interaction)
        } catch where !error.retryable && !error.isUnauthenticated && error.statusCode != nil {
            log.error("The server refused a batch's interaction: \(error.code, privacy: .public)")
        } catch {
            recordBatchFailure(batch.id, error)
            return
        }
        try store.updateBatch(batch.id) { record in
            if record.interaction == interaction {
                record.interactionSynced = true
            }
            record.retry = RetryState()
        }
        try store.removeBatchIfFinished(batch.id)
    }

    /// The id of a removed batch draft's item whose `addItemBatchItem` answer never arrived:
    /// adding at its position again returns it (or makes it, to be deleted next).
    func batchItemID(for deletion: ServerDeletionRecord) async throws(APIFailure) -> String? {
        guard let batchID = deletion.serverBatchID, let position = deletion.batchPosition else { return nil }
        return try await api.addItemBatchItem(
            batchID: batchID,
            position: position,
            idempotencyKey: UUID().uuidString.lowercased(),
        ).id
    }
}
