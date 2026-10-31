import Foundation
import GRDB

/// Upgrading a kept scan's draft (docs/features/thrift-scan.md, "Upgrading drafts"): its real
/// photos replace the scan's shots.
extension DraftStore {
    /// Puts the photos of a guided shoot first, in order, and drops the draft's scan shots unless
    /// `keepingScanShots`, in which case they follow the new photos. A dropped shot already on the
    /// server is deleted there by the upload queue. Returns the dropped photos so the caller can
    /// stop their transfers.
    @discardableResult
    func replaceScanShots(
        of draftID: String,
        with photos: [(PreparedPhoto, PhotoRole)],
        keepingScanShots: Bool,
    ) throws -> [DraftPhotoRecord] {
        guard !photos.isEmpty else { return [] }
        let existing = try writer.read { db in try Self.photos(of: draftID, in: db) }
        let staying = keepingScanShots ? existing.count : existing.count(where: { !$0.isScanShot })
        guard staying + photos.count <= Self.maxPhotosPerDraft else { throw DraftStoreError.tooManyPhotos }
        let records = try writeFiles(photos, draftID: draftID, firstPosition: 0)
        let dropped: [DraftPhotoRecord]
        do {
            dropped = try writer.write { db -> [DraftPhotoRecord] in
                guard try DraftRecord.exists(db, key: draftID) else { throw DraftStoreError.notFound }
                let current = try Self.photos(of: draftID, in: db)
                let drop = keepingScanShots ? [] : current.filter(\.isScanShot)
                let kept = current.filter { photo in !drop.contains { $0.id == photo.id } }
                guard kept.count + records.count <= Self.maxPhotosPerDraft else {
                    throw DraftStoreError.tooManyPhotos
                }
                for photo in drop {
                    try recordServerDeletion(of: photo, in: db)
                    try photo.delete(db)
                }
                // Inserted past the others, then everything numbered with the new photos first.
                var inserted: [DraftPhotoRecord] = []
                for (offset, var record) in records.enumerated() {
                    record.position = current.count + offset
                    try record.insert(db)
                    inserted.append(record)
                }
                try Self.renumber(inserted + kept, in: db)
                return drop
            }
        } catch {
            removeFiles(of: records)
            throw error
        }
        removeFiles(of: dropped)
        return dropped
    }
}
