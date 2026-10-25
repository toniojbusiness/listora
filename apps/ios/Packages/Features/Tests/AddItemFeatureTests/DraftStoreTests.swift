import Foundation
import Testing
@testable import AddItemFeature

struct DraftStoreTests {
    private let directory: TemporaryDirectory
    private let store: DraftStore

    init() throws {
        directory = try TemporaryDirectory()
        store = try DraftStore(database: DraftDatabase(directory: directory.url))
    }

    private func photos(_ roles: [PhotoRole]) throws -> [(PreparedPhoto, PhotoRole)] {
        try roles.enumerated().map { index, role in try (TestImages.prepared(seed: UInt64(index + 1)), role) }
    }

    @Test
    func `a draft and its photo files survive reopening the database, as after a relaunch`() throws {
        let draft = try store.createDraft(photos: photos([.front, .back, .tag]))

        let reopened = try DraftStore(database: DraftDatabase(directory: directory.url))

        let saved = try #require(try reopened.draft(id: draft.id))
        #expect(saved.photos.map(\.role) == [.front, .back, .tag])
        #expect(saved.photos.map(\.position) == [0, 1, 2])
        #expect(saved.photos.map(\.step) == [.session, .session, .session])
        #expect(saved.photos.map(\.tagReadState) == [.notNeeded, .notNeeded, .pending])
        for photo in saved.photos {
            let data = try reopened.imageData(of: photo)
            #expect(data.count == photo.byteSize)
        }
    }

    @Test
    func `opens in a directory whose path has spaces, like Application Support`() throws {
        let spaced = directory.url.appending(path: "Application Support/Drafts", directoryHint: .isDirectory)

        let store = try DraftStore(database: DraftDatabase(directory: spaced))
        try store.createDraft(photos: photos([.front]))

        #expect(try DraftStore(database: DraftDatabase(directory: spaced)).drafts().count == 1)
    }

    @Test
    func `drafts list newest first`() throws {
        let first = try store.createDraft(photos: photos([.front]))
        let second = try store.createDraft(photos: photos([.front]))

        #expect(try store.drafts().map(\.id) == [second.id, first.id])
    }

    @Test
    func `moving a photo renumbers the others and the first is the cover`() throws {
        let draft = try store.createDraft(photos: photos([.front, .back, .detail]))
        let ids = try #require(try store.draft(id: draft.id)).photos.map(\.id)

        try store.movePhoto(ids[2], to: 0)

        let moved = try #require(try store.draft(id: draft.id)).photos
        #expect(moved.map(\.id) == [ids[2], ids[0], ids[1]])
        #expect(moved.map(\.position) == [0, 1, 2])
    }

    @Test
    func `a draft holds at most 24 photos`() throws {
        let draft = try store.createDraft(photos: photos(Array(repeating: .detail, count: 23)))

        #expect(throws: DraftStoreError.tooManyPhotos) {
            try store.addPhotos(photos([.detail, .detail]), to: draft.id)
        }
        try store.addPhotos(photos([.detail]), to: draft.id)
        #expect(try store.draft(id: draft.id)?.photos.count == 24)
    }

    @Test
    func `removing a photo that never reached the server removes it and its file, nothing else`() throws {
        let draft = try store.createDraft(photos: photos([.front, .back]))
        let photo = try #require(try store.draft(id: draft.id)?.photos.first)
        let file = store.fileURL(for: photo)

        try store.deletePhoto(photo.id)

        #expect(try store.draft(id: draft.id)?.photos.map(\.position) == [0])
        #expect(!FileManager.default.fileExists(atPath: file.path(percentEncoded: false)))
        #expect(try store.uploadSnapshot().deletions.isEmpty)
    }

    @Test
    func `removing an attached photo records its deletion on the server`() throws {
        let draft = try attachedDraft(roles: [.front, .back])
        let photo = try #require(try store.draft(id: draft.id)?.photos.first)

        try store.deletePhoto(photo.id)

        let deletion = try #require(try store.uploadSnapshot().deletions.first)
        #expect(deletion.kind == .photo)
        #expect(deletion.serverItemID == "item-1")
        #expect(deletion.serverPhotoID == photo.serverPhotoID)
    }

    @Test
    func `deleting a draft whose item may exist on the server records the item's deletion`() throws {
        let unsent = try store.createDraft(photos: photos([.front]))
        let sent = try attachedDraft(roles: [.front])

        let removed = try store.deleteDraft(unsent.id)
        try store.deleteDraft(sent.id)

        #expect(removed.count == 1)
        #expect(try store.drafts().isEmpty)
        let deletions = try store.uploadSnapshot().deletions
        #expect(deletions.map(\.kind) == [.item])
        #expect(deletions.first?.serverItemID == "item-1")
        #expect(try store.uploadSnapshot().photos.isEmpty)
    }

    @Test
    func `completing a saved draft removes only this iPhone's copy, never the server item`() throws {
        let draft = try attachedDraft(roles: [.front, .back])
        let photos = try #require(try store.draft(id: draft.id)).photos
        // A photo removed earlier still has its server deletion queued.
        try store.deletePhoto(photos[1].id)

        let removed = try store.completeDraft(draft.id)

        #expect(removed.map(\.id) == [photos[0].id])
        #expect(try store.drafts().isEmpty)
        let deletions = try store.uploadSnapshot().deletions
        #expect(deletions.map(\.kind) == [.photo], "the saved item stays on the server")
        #expect(!FileManager.default.fileExists(atPath: store.fileURL(for: photos[0]).path(percentEncoded: false)))
    }

    @Test
    func `a photo that becomes a tag after it was attached without tag reads uploads again`() throws {
        let draft = try attachedDraft(roles: [.front, .detail])
        let photo = try #require(try store.draft(id: draft.id)?.photos.last)

        try store.setRole(.tag, of: photo.id)

        let replaced = try #require(try store.draft(id: draft.id)?.photos.last)
        #expect(replaced.id == photo.id)
        #expect(replaced.attachKey != photo.attachKey)
        #expect(replaced.serverPhotoID == nil)
        #expect(replaced.role == .tag)
        #expect(replaced.tagReadState == .pending)
        #expect(replaced.step == .session)
        #expect(replaced.fileName == photo.fileName)
        #expect(FileManager.default.fileExists(atPath: store.fileURL(for: replaced).path(percentEncoded: false)))
        #expect(try store.uploadSnapshot().deletions.map(\.serverPhotoID) == [photo.serverPhotoID])
    }

    @Test
    func `other role changes keep the photo and leave the server copy for a role update`() throws {
        let draft = try attachedDraft(roles: [.front, .detail])
        let photo = try #require(try store.draft(id: draft.id)?.photos.last)

        try store.setRole(.flaw, of: photo.id)

        let updated = try #require(try store.draft(id: draft.id)?.photos.last)
        #expect(updated.id == photo.id)
        #expect(updated.role == .flaw)
        #expect(updated.serverRole == .detail)
        #expect(try store.uploadSnapshot().deletions.isEmpty)
    }

    @Test
    func `cropping replaces the image in place and removes the old one from the server`() throws {
        let draft = try attachedDraft(roles: [.front, .back])
        let photo = try #require(try store.draft(id: draft.id)?.photos.first)

        let (old, new) = try store.replaceImage(of: photo.id, with: TestImages.prepared(seed: 99))

        let photos = try #require(try store.draft(id: draft.id)).photos
        #expect(photos.first?.id == new.id)
        #expect(photos.first?.role == .front)
        #expect(photos.first?.step == .session)
        #expect(!FileManager.default.fileExists(atPath: store.fileURL(for: old).path(percentEncoded: false)))
        #expect(try store.uploadSnapshot().deletions.map(\.serverPhotoID) == [photo.serverPhotoID])
    }

    @Test
    func `the Retry action clears stopped failures of the draft and its photos`() throws {
        let draft = try store.createDraft(photos: photos([.front]))
        let photo = try #require(try store.draft(id: draft.id)?.photos.first)
        let stopped = RetryState(attempt: 8, retryAt: nil, failure: "Listora is busy.")
        try store.updateDraft(draft.id) { $0.retry = stopped }
        try store.updatePhoto(photo.id) { $0.retry = stopped }

        try store.retry(draftID: draft.id)

        let retried = try #require(try store.draft(id: draft.id))
        #expect(retried.record.retry == RetryState())
        #expect(retried.photos.first?.retry == RetryState())
    }

    /// A draft as if the queue had created its item and attached every photo.
    private func attachedDraft(roles: [PhotoRole]) throws -> DraftRecord {
        let draft = try store.createDraft(photos: photos(roles))
        try store.updateDraft(draft.id) { record in
            record.createItemSent = true
            record.serverItemID = "item-1"
        }
        for photo in try #require(try store.draft(id: draft.id)).photos {
            try store.updatePhoto(photo.id) { record in
                record.step = .done
                record.uploadFileID = "file-\(record.position)"
                record.attachRequest = AttachRequest(
                    uploadFileID: "file-\(record.position)",
                    role: record.role,
                    width: record.width,
                    height: record.height,
                    tagReads: nil,
                )
                record.serverPhotoID = "photo-\(record.position)"
                record.serverRole = record.role
            }
        }
        return draft
    }
}
