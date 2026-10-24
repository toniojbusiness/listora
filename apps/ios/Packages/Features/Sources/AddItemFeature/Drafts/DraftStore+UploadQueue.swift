import Foundation
import GRDB

/// What the upload queue reads and writes. Each change applies only if the row still exists,
/// because the user may have removed it while a request ran.
extension DraftStore {
    /// Everything the upload queue plans from.
    func uploadSnapshot() throws -> UploadSnapshot {
        try writer.read { db in
            try UploadSnapshot(
                drafts: DraftRecord.order(DraftRecord.Columns.createdAt).fetchAll(db),
                photos: DraftPhotoRecord.order(DraftPhotoRecord.Columns.position).fetchAll(db),
                deletions: ServerDeletionRecord.order(Column("createdAt")).fetchAll(db),
            )
        }
    }

    /// Applies `change` to a draft if it still exists. Returns the updated draft.
    @discardableResult
    func updateDraft(_ id: String, _ change: @escaping @Sendable (inout DraftRecord) -> Void) throws -> DraftRecord? {
        try writer.write { db in
            guard var draft = try DraftRecord.fetchOne(db, key: id) else { return nil }
            change(&draft)
            try draft.update(db)
            return draft
        }
    }

    /// Applies `change` to a photo if it still exists. Returns the updated photo.
    @discardableResult
    func updatePhoto(
        _ id: String,
        _ change: @escaping @Sendable (inout DraftPhotoRecord) -> Void,
    ) throws -> DraftPhotoRecord? {
        try writer.write { db in
            guard var photo = try DraftPhotoRecord.fetchOne(db, key: id) else { return nil }
            change(&photo)
            try photo.update(db)
            return photo
        }
    }

    func updateDeletion(_ id: String, _ change: @escaping @Sendable (inout ServerDeletionRecord) -> Void) throws {
        try writer.write { db in
            guard var deletion = try ServerDeletionRecord.fetchOne(db, key: id) else { return }
            change(&deletion)
            try deletion.update(db)
        }
    }

    func removeDeletion(_ id: String) throws {
        _ = try writer.write { db in try ServerDeletionRecord.deleteOne(db, key: id) }
    }

    /// Reads the photo's prepared JPEG.
    func imageData(of photo: DraftPhotoRecord) throws -> Data {
        try Data(contentsOf: database.fileURL(for: photo))
    }
}
