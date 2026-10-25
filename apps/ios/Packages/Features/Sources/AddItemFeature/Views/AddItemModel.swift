import Core
import Foundation
import Observation
import os

/// The Add Item tab's state and actions. Every change goes to the on-device store first, then
/// wakes the upload queue; heavy work (decoding, resizing, writing files) runs off the main actor.
@MainActor
@Observable
final class AddItemModel {
    let store: DraftStore
    let uploader: PhotoUploader
    let activity: UploadActivity
    /// Measures each new item's interaction time from its first photo.
    let meter: InteractionMeter
    /// The drafts of single items; a batch's drafts show with their batch.
    private(set) var drafts: [Draft] = []
    /// The batches on this iPhone, newest first.
    var batches: [Batch] = []
    /// A problem to show in an alert.
    var errorMessage: String?
    /// Photos being prepared for a new or existing draft or batch.
    var isPreparingPhotos = false
    let log = Logger(subsystem: "com.listora.app", category: "drafts")
    /// The measurement of a new item whose draft does not exist yet (the camera is open, or the
    /// photos are being prepared).
    private var pendingSession: String?

    init(store: DraftStore, uploader: PhotoUploader, activity: UploadActivity, meter: InteractionMeter) {
        self.store = store
        self.uploader = uploader
        self.activity = activity
        self.meter = meter
    }

    /// The seller started a new item (opened the camera, or picked photos): its measurement starts
    /// now and becomes the draft's once the draft is saved.
    func beginNewItem() {
        if let pendingSession {
            meter.leave(pendingSession)
            meter.discard(pendingSession)
        }
        let session = "pending-\(UUID().uuidString.lowercased())"
        meter.begin(session)
        meter.enter(session)
        pendingSession = session
    }

    /// Hands the pending measurement to the new draft, or drops it when nothing was saved.
    private func endPendingSession(draftID: String?) {
        guard let pendingSession else { return }
        self.pendingSession = nil
        meter.setWaiting(false, for: pendingSession)
        if let draftID {
            meter.rename(pendingSession, to: draftID)
            meter.leave(draftID)
        } else {
            meter.leave(pendingSession)
            meter.discard(pendingSession)
        }
    }

    /// Keeps ``drafts`` current until the calling task is cancelled.
    func observeDrafts() async {
        do {
            for try await drafts in store.observeDrafts() {
                self.drafts = drafts.filter { $0.record.batchID == nil }
            }
        } catch {
            log.error("Observing drafts failed: \(String(describing: error), privacy: .public)")
        }
    }

    /// Prepares photos (resize, JPEG, no GPS) and saves them as a new draft, or adds them to
    /// `draftID`. Each photo's role comes from its place in the selection. Returns the draft's id,
    /// or nil when nothing was saved.
    func addPhotos(_ images: [Data], to draftID: String? = nil) async -> String? {
        guard !images.isEmpty else { return nil }
        if draftID == nil {
            if pendingSession == nil {
                beginNewItem()
            }
            if let pendingSession {
                meter.setWaiting(true, for: pendingSession)
            }
        }
        isPreparingPhotos = true
        defer { isPreparingPhotos = false }
        let offset = draftID.flatMap { id in drafts.first { $0.id == id }?.photos.count } ?? 0
        let prepared = await Task.detached(priority: .userInitiated) { () -> Result<
            [(PreparedPhoto, PhotoRole)],
            any Error,
        > in
            Result {
                try images.enumerated().map { index, image in
                    try (PhotoPreparation.prepare(image), PhotoRole.defaultRole(forImportAt: offset + index))
                }
            }
        }.value
        switch prepared {
        case let .success(photos):
            return await save(photos, to: draftID)
        case let .failure(error):
            show(error)
            if draftID == nil {
                endPendingSession(draftID: nil)
            }
            return nil
        }
    }

    /// Saves prepared photos (from the camera, with their roles) as a new draft, or adds them to
    /// `draftID`. Returns the draft's id, or nil when nothing was saved.
    func save(_ photos: [(PreparedPhoto, PhotoRole)], to draftID: String? = nil) async -> String? {
        guard !photos.isEmpty else {
            if draftID == nil {
                endPendingSession(draftID: nil)
            }
            return nil
        }
        let store = store
        let result = await Task.detached(priority: .userInitiated) {
            Result {
                if let draftID {
                    try store.addPhotos(photos, to: draftID)
                    return draftID
                }
                return try store.createDraft(photos: photos).id
            }
        }.value
        switch result {
        case let .success(id):
            if draftID == nil {
                endPendingSession(draftID: id)
            }
            await uploader.wake()
            return id
        case let .failure(error):
            show(error)
            if draftID == nil {
                endPendingSession(draftID: nil)
            }
            return nil
        }
    }

    func setRole(_ role: PhotoRole, of photoID: String) {
        perform { try $0.setRole(role, of: photoID) }
    }

    func movePhoto(_ photoID: String, to position: Int) {
        perform { try $0.movePhoto(photoID, to: position) }
    }

    func deletePhoto(_ photoID: String) {
        perform { store in
            if let removed = try store.deletePhoto(photoID) {
                cancelTransfers(of: [removed.id])
            }
        }
    }

    func deleteDraft(_ draftID: String) {
        perform { store in
            try cancelTransfers(of: store.deleteDraft(draftID).map(\.id))
        }
        meter.discard(draftID)
    }

    /// The draft's item was saved in review: only this iPhone's copy of the draft goes (and its
    /// batch, once nothing else of the batch is left here).
    func completeDraft(_ draftID: String) {
        let batchID = try? store.draft(id: draftID)?.record.batchID
        perform { store in
            try cancelTransfers(of: store.completeDraft(draftID).map(\.id))
            if let batchID, try store.removeBatchIfFinished(batchID) {
                meter.discard(BatchRecord.meterSession(batchID))
            }
        }
    }

    func retry(_ draftID: String) {
        perform { try $0.retry(draftID: draftID) }
    }

    /// Crops a photo to `rect` (normalized, origin top left) and replaces it with the result.
    func crop(_ photo: DraftPhotoRecord, to rect: CGRect) async {
        let store = store
        let result = await Task.detached(priority: .userInitiated) {
            Result {
                let cropped = try PhotoPreparation.crop(store.imageData(of: photo), to: rect)
                return try store.replaceImage(of: photo.id, with: cropped).old.id
            }
        }.value
        switch result {
        case let .success(oldID):
            cancelTransfers(of: [oldID])
            await uploader.wake()
        case let .failure(error):
            show(error)
        }
    }

    private func perform(_ change: (DraftStore) throws -> Void) {
        do {
            try change(store)
        } catch {
            show(error)
            return
        }
        let uploader = uploader
        Task { await uploader.wake() }
    }

    private func cancelTransfers(of photoIDs: [String]) {
        let uploader = uploader
        Task { await uploader.cancelTransfers(of: photoIDs) }
    }

    func show(_ error: any Error) {
        log.error("Draft change failed: \(String(describing: error), privacy: .public)")
        errorMessage = switch error {
        case DraftStoreError.tooManyPhotos:
            "An item can have at most \(DraftStore.maxPhotosPerDraft) photos. Remove one first."
        case DraftStoreError.notFound:
            "This draft was deleted."
        case PhotoPreparationError.unreadableImage:
            "One of the photos could not be read. Try a different photo."
        default:
            "Listora couldn't save the photos on this iPhone. Free up some storage and try again."
        }
    }
}
