import Core
import Foundation
import GRDB

/// When a request may run again after a failure, and what stopped it. Drafts, photos, and server
/// deletions each carry one for their own requests.
struct RetryState: Codable, Equatable, Sendable {
    /// Failed attempts counted toward the policy's limit: those of the current step, plus every
    /// ``setbacks`` failure.
    var attempt = 0
    /// Failures that sent the row back to an earlier step (an expired session, a missing file,
    /// bytes that did not all arrive). The earlier steps succeeding again does not clear them, so
    /// a row that can never finish still stops.
    var setbacks = 0
    /// The next attempt waits until then.
    var retryAt: Date?
    /// Set when retrying stopped: a user-readable reason. Only the user's Retry clears it.
    var failure: String?

    func isRunnable(at now: Date) -> Bool {
        failure == nil && (retryAt.map { $0 <= now } ?? true)
    }

    /// A step before the last one succeeded: its own failures no longer count, setbacks still do.
    mutating func stepSucceeded() {
        attempt = setbacks
        retryAt = nil
    }
}

/// One item being created on the phone. It exists on the device first; the upload queue creates
/// its server item (`createItem`) and attaches its photos.
struct DraftRecord: Codable, Equatable, Identifiable, Sendable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "draft"

    var id: String
    var createdAt: Date
    /// The `Idempotency-Key` of this draft's `createItem`, reused on every retry.
    var createItemKey: String
    /// True once `createItem` may have reached the server, so deleting the draft must delete the
    /// server item too.
    var createItemSent = false
    var serverItemID: String?
    var sku: String?
    /// The server photo ids in the order last sent with `reorderItemPhotos`.
    var syncedPhotoOrder: [String]?
    var retry = RetryState()
    /// The batch this draft came from (docs/features/batch.md); its server item is created in
    /// the batch, at `batchPosition`, with `createItemKey` as the `addItemBatchItem` key.
    var batchID: String?
    var batchPosition: Int?
    /// The `Idempotency-Key` of the next `submitItemBatchItem`, and the server photos the last
    /// one submitted: a batch draft is submitted again when its photos change.
    var submitKey: String?
    var submittedPhotoIDs: [String]?
    /// The thrift scan this draft was kept from (docs/features/thrift-scan.md): its server item is
    /// the scan's (`keepScan`, with `createItemKey` as the key), carrying what the scan read.
    var scanID: String?

    enum Columns {
        static let createdAt = Column(CodingKeys.createdAt)
        static let batchID = Column(CodingKeys.batchID)
    }

    static func new(now: Date) -> DraftRecord {
        DraftRecord(id: UUID().uuidString.lowercased(), createdAt: now, createItemKey: UUID().uuidString.lowercased())
    }
}

/// How far a photo's upload has come.
enum UploadStep: String, Codable, Sendable {
    /// Needs an upload session (`createUploadSession`).
    case session
    /// Needs its bytes sent to the session's upload target.
    case transfer
    /// Bytes are on the server; needs `addItemPhoto`.
    case attach
    /// Attached to the server item.
    case done
}

/// Whether a tag photo's text and barcodes have been read on the device.
enum TagReadState: String, Codable, Sendable {
    /// Not a tag photo.
    case notNeeded
    case pending
    case done
    /// Reading failed; the photo uploads without reads.
    case failed
}

/// Where the bytes of one upload go: the contract's `UploadTarget`.
struct UploadTarget: Codable, Equatable, Sendable {
    struct Header: Codable, Equatable, Sendable {
        var name: String
        var value: String
    }

    var url: URL
    var headers: [Header]
    var expiresAt: Date

    /// Targets this close to expiring are refreshed instead of used.
    static let safetyMargin: TimeInterval = 60

    func isUsable(at now: Date) -> Bool {
        expiresAt.timeIntervalSince(now) > Self.safetyMargin
    }
}

/// The body of a photo's `addItemPhoto`, fixed when it is first sent so every retry with the same
/// `Idempotency-Key` sends the same body.
struct AttachRequest: Codable, Equatable, Sendable {
    var uploadFileID: String
    var role: PhotoRole
    var width: Int
    var height: Int
    var tagReads: PhotoTagReadUpload?
}

/// One photo of a draft: the prepared JPEG on disk and its upload progress.
struct DraftPhotoRecord: Codable, Equatable, Identifiable, Sendable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "draftPhoto"

    var id: String
    var draftID: String
    /// 0 is the cover.
    var position: Int
    var role: PhotoRole
    /// The prepared JPEG in the store's photo directory.
    var fileName: String
    /// After a background cleanup, the photo as it was before, kept on this iPhone so the cleanup
    /// can be undone. Nil for a photo that was not cleaned up (or was cropped since).
    var originalFileName: String?
    var width: Int
    var height: Int
    var byteSize: Int
    var sha256: String
    var looksBlurry: Bool
    var tagReadState: TagReadState
    var tagReads: PhotoTagReadUpload?
    var createdAt: Date

    var step: UploadStep = .session
    /// The `Idempotency-Key` of this photo's `createUploadSession`.
    var sessionKey: String
    var sessionID: String?
    var uploadFileID: String?
    var target: UploadTarget?
    /// The `Idempotency-Key` of this photo's `addItemPhoto`.
    var attachKey: String
    /// Set just before `addItemPhoto` is first sent.
    var attachRequest: AttachRequest?
    var serverPhotoID: String?
    /// The role the server has, so a changed role is sent with `updateItemPhoto`.
    var serverRole: PhotoRole?
    var retry = RetryState()

    enum Columns {
        static let draftID = Column(CodingKeys.draftID)
        static let position = Column(CodingKeys.position)
    }

    static func new(
        draftID: String,
        position: Int,
        role: PhotoRole,
        photo: PreparedPhoto,
        now: Date,
    ) -> DraftPhotoRecord {
        let id = UUID().uuidString.lowercased()
        return DraftPhotoRecord(
            id: id,
            draftID: draftID,
            position: position,
            role: role,
            fileName: "\(id).jpg",
            width: photo.width,
            height: photo.height,
            byteSize: photo.data.count,
            sha256: photo.sha256,
            looksBlurry: photo.looksBlurry,
            tagReadState: role == .tag ? .pending : .notNeeded,
            createdAt: now,
            sessionKey: UUID().uuidString.lowercased(),
            attachKey: UUID().uuidString.lowercased(),
        )
    }

    /// True once `addItemPhoto` may have reached the server, so removing the photo must remove the
    /// server's copy too.
    var mayBeOnServer: Bool {
        serverPhotoID != nil || attachRequest != nil
    }

    /// Starts the upload over with a new session: the old one expired or its file is gone. Nothing
    /// was attached, so nothing on the server needs removing.
    mutating func restartUpload() {
        step = .session
        sessionKey = UUID().uuidString.lowercased()
        sessionID = nil
        uploadFileID = nil
        target = nil
        attachKey = UUID().uuidString.lowercased()
        attachRequest = nil
        serverPhotoID = nil
        serverRole = nil
    }
}

/// Something the server still has that the user removed on the phone: a deleted draft's item or a
/// removed photo. The upload queue deletes it, retrying until the server confirms.
struct ServerDeletionRecord: Codable, Equatable, Identifiable, Sendable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "serverDeletion"

    enum Kind: String, Codable, Sendable {
        case item
        case photo
    }

    var id: String
    var kind: Kind
    var createdAt: Date
    var serverItemID: String?
    /// For an item whose `createItem` answer never arrived: replaying it returns the item's id.
    var createItemKey: String?
    var serverPhotoID: String?
    /// For a photo whose `addItemPhoto` answer never arrived: replaying it returns the photo's id.
    var attachKey: String?
    var attachRequest: AttachRequest?
    /// The removed photo's SHA-256, to find it on the item once the replay's answer is gone.
    var sha256: String?
    var retry = RetryState()
    /// For a batch item whose `addItemBatchItem` answer never arrived: adding at its position
    /// again returns the item.
    var serverBatchID: String?
    var batchPosition: Int?
    /// For a kept scan's item whose `keepScan` answer never arrived: keeping the scan again
    /// returns the item.
    var scanID: String?

    static func item(_ draft: DraftRecord, serverBatchID: String?, now: Date) -> ServerDeletionRecord {
        let unknown = draft.serverItemID == nil
        let inBatch = draft.batchID != nil
        let fromScan = draft.scanID != nil
        return ServerDeletionRecord(
            id: UUID().uuidString.lowercased(),
            kind: .item,
            createdAt: now,
            serverItemID: draft.serverItemID,
            createItemKey: unknown && !inBatch && !fromScan ? draft.createItemKey : nil,
            serverBatchID: unknown && inBatch ? serverBatchID : nil,
            batchPosition: unknown && inBatch ? draft.batchPosition : nil,
            scanID: unknown ? draft.scanID : nil,
        )
    }

    static func photo(_ photo: DraftPhotoRecord, serverItemID: String, now: Date) -> ServerDeletionRecord {
        ServerDeletionRecord(
            id: UUID().uuidString.lowercased(),
            kind: .photo,
            createdAt: now,
            serverItemID: serverItemID,
            serverPhotoID: photo.serverPhotoID,
            attachKey: photo.serverPhotoID == nil ? photo.attachKey : nil,
            attachRequest: photo.serverPhotoID == nil ? photo.attachRequest : nil,
            sha256: photo.sha256,
        )
    }
}
