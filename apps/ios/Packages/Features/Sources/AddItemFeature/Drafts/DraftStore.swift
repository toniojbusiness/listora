import Foundation
import GRDB

/// A draft with its photos in order (the first is the cover).
struct Draft: Equatable, Identifiable, Sendable {
    let record: DraftRecord
    let photos: [DraftPhotoRecord]

    var id: String {
        record.id
    }
}

enum DraftStoreError: Error, Equatable {
    case tooManyPhotos
    case notFound
}

/// Reads and changes drafts on the device. Every change is one transaction; photo files are
/// written before the rows that name them and removed after the rows are gone, so a crash leaves at
/// worst an unused file, never a row without its file.
///
/// Changes keep the server in step through the upload queue: removing something that may already be
/// on the server records a ``ServerDeletionRecord`` in the same transaction.
final class DraftStore: Sendable {
    /// The API's limit per item.
    static let maxPhotosPerDraft = 24

    let database: DraftDatabase
    private let now: @Sendable () -> Date

    init(database: DraftDatabase, now: @escaping @Sendable () -> Date = Date.init) {
        self.database = database
        self.now = now
    }

    var writer: any DatabaseWriter {
        database.writer
    }

    // MARK: Reading

    /// Every draft, newest first, and then every change to them.
    func observeDrafts() -> AsyncValueObservation<[Draft]> {
        ValueObservation
            .tracking { db in try Self.fetchDrafts(db) }
            .removeDuplicates()
            .values(in: writer)
    }

    /// One draft, nil once it is deleted, and then every change to it.
    func observeDraft(id: String) -> AsyncValueObservation<Draft?> {
        ValueObservation
            .tracking { db in try Self.fetchDraft(db, id: id) }
            .removeDuplicates()
            .values(in: writer)
    }

    func draft(id: String) throws -> Draft? {
        try writer.read { db in try Self.fetchDraft(db, id: id) }
    }

    func drafts() throws -> [Draft] {
        try writer.read { db in try Self.fetchDrafts(db) }
    }

    func fileURL(for photo: DraftPhotoRecord) -> URL {
        database.fileURL(for: photo)
    }

    private static func fetchDrafts(_ db: Database) throws -> [Draft] {
        let drafts = try DraftRecord.order(DraftRecord.Columns.createdAt.desc).fetchAll(db)
        let photos = try Dictionary(grouping: DraftPhotoRecord.order(DraftPhotoRecord.Columns.position).fetchAll(db)) {
            $0.draftID
        }
        return drafts.map { Draft(record: $0, photos: photos[$0.id] ?? []) }
    }

    private static func fetchDraft(_ db: Database, id: String) throws -> Draft? {
        guard let record = try DraftRecord.fetchOne(db, key: id) else { return nil }
        let photos = try DraftPhotoRecord
            .filter(DraftPhotoRecord.Columns.draftID == id)
            .order(DraftPhotoRecord.Columns.position)
            .fetchAll(db)
        return Draft(record: record, photos: photos)
    }

    // MARK: Creating

    /// Saves a new draft with `photos` in order.
    @discardableResult
    func createDraft(photos: [(PreparedPhoto, PhotoRole)]) throws -> DraftRecord {
        guard photos.count <= Self.maxPhotosPerDraft else { throw DraftStoreError.tooManyPhotos }
        let draft = DraftRecord.new(now: now())
        let records = try writeFiles(photos, draftID: draft.id, firstPosition: 0)
        do {
            try writer.write { db in
                try draft.insert(db)
                for record in records {
                    try record.insert(db)
                }
            }
        } catch {
            removeFiles(of: records)
            throw error
        }
        return draft
    }

    /// Appends photos to a draft.
    func addPhotos(_ photos: [(PreparedPhoto, PhotoRole)], to draftID: String) throws {
        let count = try writer.read { db in
            try DraftPhotoRecord.filter(DraftPhotoRecord.Columns.draftID == draftID).fetchCount(db)
        }
        guard count + photos.count <= Self.maxPhotosPerDraft else { throw DraftStoreError.tooManyPhotos }
        let records = try writeFiles(photos, draftID: draftID, firstPosition: count)
        do {
            try writer.write { db in
                guard try DraftRecord.exists(db, key: draftID) else { throw DraftStoreError.notFound }
                let existing = try DraftPhotoRecord.filter(DraftPhotoRecord.Columns.draftID == draftID).fetchCount(db)
                guard existing + records.count <= Self.maxPhotosPerDraft else { throw DraftStoreError.tooManyPhotos }
                for (offset, var record) in records.enumerated() {
                    record.position = existing + offset
                    try record.insert(db)
                }
            }
        } catch {
            removeFiles(of: records)
            throw error
        }
    }

    // MARK: Editing

    /// Changes a photo's role. A photo that becomes a tag photo is read on the device before it
    /// uploads; if it was already attached without those reads, it is uploaded again as a new
    /// photo, because the server takes tag reads only with a new photo.
    func setRole(_ role: PhotoRole, of photoID: String) throws {
        try writer.write { db in
            guard var photo = try DraftPhotoRecord.fetchOne(db, key: photoID) else { throw DraftStoreError.notFound }
            guard photo.role != role else { return }
            photo.role = role
            if role == .tag, photo.tagReadState == .notNeeded {
                photo.tagReadState = .pending
            }
            let sentWithoutReads = photo.attachRequest.map { $0.role != .tag } ?? false
            if role == .tag, sentWithoutReads {
                try reupload(photo, in: db)
            } else {
                try photo.update(db)
            }
        }
    }

    /// Moves a photo to `position` (0 makes it the cover); the others keep their order.
    func movePhoto(_ photoID: String, to position: Int) throws {
        try writer.write { db in
            guard let photo = try DraftPhotoRecord.fetchOne(db, key: photoID) else { throw DraftStoreError.notFound }
            var photos = try Self.photos(of: photo.draftID, in: db)
            guard let from = photos.firstIndex(where: { $0.id == photoID }) else { return }
            let moved = photos.remove(at: from)
            photos.insert(moved, at: min(max(position, 0), photos.count))
            try Self.renumber(photos, in: db)
        }
    }

    /// Removes a photo. Returns it so the caller can stop its transfer.
    @discardableResult
    func deletePhoto(_ photoID: String) throws -> DraftPhotoRecord? {
        let removed = try writer.write { db -> DraftPhotoRecord? in
            guard let photo = try DraftPhotoRecord.fetchOne(db, key: photoID) else { return nil }
            try recordServerDeletion(of: photo, in: db)
            try photo.delete(db)
            try Self.renumber(Self.photos(of: photo.draftID, in: db), in: db)
            return photo
        }
        if let removed {
            removeFiles(of: [removed])
        }
        return removed
    }

    /// Replaces a photo's image (after cropping) with `photo`, in the same place and role. The new
    /// image uploads as a new photo; the old one is removed from the server. Returns the old record
    /// so the caller can stop its transfer, and the new one.
    @discardableResult
    func replaceImage(
        of photoID: String,
        with photo: PreparedPhoto,
    ) throws -> (old: DraftPhotoRecord, new: DraftPhotoRecord) {
        guard let current = try writer.read({ db in try DraftPhotoRecord.fetchOne(db, key: photoID) }) else {
            throw DraftStoreError.notFound
        }
        let replacement = DraftPhotoRecord.new(
            draftID: current.draftID,
            position: current.position,
            role: current.role,
            photo: photo,
            now: now(),
        )
        try photo.data.write(
            to: database.fileURL(for: replacement),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication],
        )
        do {
            try writer.write { db in
                guard try DraftPhotoRecord.exists(db, key: photoID) else { throw DraftStoreError.notFound }
                try recordServerDeletion(of: current, in: db)
                try current.delete(db)
                try replacement.insert(db)
            }
        } catch {
            removeFiles(of: [replacement])
            throw error
        }
        removeFiles(of: [current])
        return (current, replacement)
    }

    /// Deletes a draft and its photos; its server item is deleted by the upload queue. Returns the
    /// removed photos so the caller can stop their transfers.
    @discardableResult
    func deleteDraft(_ draftID: String) throws -> [DraftPhotoRecord] {
        let photos = try writer.write { db -> [DraftPhotoRecord] in
            guard let draft = try DraftRecord.fetchOne(db, key: draftID) else { return [] }
            let photos = try Self.photos(of: draftID, in: db)
            if draft.createItemSent {
                try ServerDeletionRecord.item(draft, now: now()).insert(db)
            }
            try draft.delete(db)
            return photos
        }
        removeFiles(of: photos)
        return photos
    }

    /// Clears stopped failures of a draft and its photos so the upload queue tries again now.
    func retry(draftID: String) throws {
        try writer.write { db in
            if var draft = try DraftRecord.fetchOne(db, key: draftID) {
                draft.retry = RetryState()
                try draft.update(db)
            }
            for var photo in try Self.photos(of: draftID, in: db) where photo.retry != RetryState() {
                photo.retry = RetryState()
                try photo.update(db)
            }
        }
    }

    // MARK: Helpers

    private func writeFiles(
        _ photos: [(PreparedPhoto, PhotoRole)],
        draftID: String,
        firstPosition: Int,
    ) throws -> [DraftPhotoRecord] {
        var records: [DraftPhotoRecord] = []
        do {
            for (offset, (photo, role)) in photos.enumerated() {
                let record = DraftPhotoRecord.new(
                    draftID: draftID,
                    position: firstPosition + offset,
                    role: role,
                    photo: photo,
                    now: now(),
                )
                try photo.data.write(
                    to: database.fileURL(for: record),
                    options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication],
                )
                records.append(record)
            }
        } catch {
            removeFiles(of: records)
            throw error
        }
        return records
    }

    private func removeFiles(of photos: [DraftPhotoRecord]) {
        for photo in photos {
            try? FileManager.default.removeItem(at: database.fileURL(for: photo))
        }
    }

    /// Uploads `photo` again as a new server photo from the same file, and removes the old server
    /// photo. The local photo keeps its id; its new keys make any answer still on its way for the
    /// old upload land nowhere.
    private func reupload(_ photo: DraftPhotoRecord, in db: Database) throws {
        try recordServerDeletion(of: photo, in: db)
        var again = photo
        again.restartUpload()
        again.retry = RetryState()
        try again.update(db)
    }

    private func recordServerDeletion(of photo: DraftPhotoRecord, in db: Database) throws {
        guard photo.mayBeOnServer,
              let itemID = try DraftRecord.fetchOne(db, key: photo.draftID)?.serverItemID
        else { return }
        try ServerDeletionRecord.photo(photo, serverItemID: itemID, now: now()).insert(db)
    }

    private static func photos(of draftID: String, in db: Database) throws -> [DraftPhotoRecord] {
        try DraftPhotoRecord
            .filter(DraftPhotoRecord.Columns.draftID == draftID)
            .order(DraftPhotoRecord.Columns.position)
            .fetchAll(db)
    }

    private static func renumber(_ photos: [DraftPhotoRecord], in db: Database) throws {
        for (position, var photo) in photos.enumerated() where photo.position != position {
            photo.position = position
            try photo.update(db)
        }
    }
}
