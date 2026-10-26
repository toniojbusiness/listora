import Foundation
import GRDB

/// Replacing a photo's image: after a crop, a background cleanup, or undoing a cleanup.
extension DraftStore {
    /// One photo, nil once it is removed or replaced.
    func photo(id: String) throws -> DraftPhotoRecord? {
        try writer.read { db in try DraftPhotoRecord.fetchOne(db, key: id) }
    }

    /// Replaces a photo's image (after cropping) with `photo`, in the same place and role. The new
    /// image uploads as a new photo; the old one is removed from the server. Returns the old record
    /// so the caller can stop its transfer, and the new one. A crop ends any background cleanup's
    /// undo: the original is removed with the old image.
    @discardableResult
    func replaceImage(
        of photoID: String,
        with photo: PreparedPhoto,
    ) throws -> (old: DraftPhotoRecord, new: DraftPhotoRecord) {
        try replaceImage(of: photoID, with: photo, keepingOriginal: false)
    }

    /// Replaces a photo's image with its background cleaned up (`cleaned`), keeping the photo as
    /// it was on this iPhone so ``restoreOriginal(of:)`` can undo it. Uploads like a crop.
    @discardableResult
    func cleanBackground(
        of photoID: String,
        with cleaned: PreparedPhoto,
    ) throws -> (old: DraftPhotoRecord, new: DraftPhotoRecord) {
        try replaceImage(of: photoID, with: cleaned, keepingOriginal: true)
    }

    /// Undoes a background cleanup: the photo as it was before, byte for byte, replaces the
    /// cleaned one (and uploads again). Throws ``DraftStoreError/notFound`` when the photo has no
    /// original.
    @discardableResult
    func restoreOriginal(of photoID: String) throws -> (old: DraftPhotoRecord, new: DraftPhotoRecord) {
        guard let current = try photo(id: photoID), let url = database.originalFileURL(for: current) else {
            throw DraftStoreError.notFound
        }
        let original = try PhotoPreparation.describe(Data(contentsOf: url))
        return try replaceImage(of: photoID, with: original, keepingOriginal: false)
    }

    /// `keepingOriginal` keeps the old image's file as the new photo's original (a background
    /// cleanup); otherwise the old image and any original it had are removed.
    private func replaceImage(
        of photoID: String,
        with photo: PreparedPhoto,
        keepingOriginal: Bool,
    ) throws -> (old: DraftPhotoRecord, new: DraftPhotoRecord) {
        guard let current = try writer.read({ db in try DraftPhotoRecord.fetchOne(db, key: photoID) }) else {
            throw DraftStoreError.notFound
        }
        var replacement = DraftPhotoRecord.new(
            draftID: current.draftID,
            position: current.position,
            role: current.role,
            photo: photo,
            now: now(),
        )
        if keepingOriginal {
            replacement.originalFileName = current.originalFileName ?? current.fileName
        }
        try photo.data.write(
            to: database.fileURL(for: replacement),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication],
        )
        let old: DraftPhotoRecord
        do {
            old = try writer.write { db in
                guard let latest = try DraftPhotoRecord.fetchOne(db, key: photoID),
                      latest.fileName == current.fileName else { throw DraftStoreError.notFound }
                try recordServerDeletion(of: latest, in: db)
                try latest.delete(db)
                try replacement.insert(db)
                return latest
            }
        } catch {
            try? FileManager.default.removeItem(at: database.fileURL(for: replacement))
            throw error
        }
        if keepingOriginal {
            // The old image is the new photo's original now; only an older original goes.
            if old.originalFileName != nil {
                try? FileManager.default.removeItem(at: database.fileURL(for: old))
            }
        } else {
            removeFiles(of: [old])
        }
        return (old, replacement)
    }
}
