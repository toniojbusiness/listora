import Foundation

/// The upload queue's view of the database.
struct UploadSnapshot: Equatable, Sendable {
    var drafts: [DraftRecord]
    /// All photos, in position order within each draft.
    var photos: [DraftPhotoRecord]
    var deletions: [ServerDeletionRecord]
}

/// One step of bringing the server in line with the drafts on the phone.
enum UploadWork: Equatable, Sendable {
    /// Read text and barcodes on a tag photo, on the device.
    case readTag(photoID: String)
    case createSession(photoID: String)
    /// Get a fresh upload target, or learn that the bytes already arrived.
    case refreshTarget(photoID: String)
    case startTransfer(photoID: String)
    case createItem(draftID: String)
    case attach(photoID: String)
    case deleteOnServer(deletionID: String)
    case syncRole(photoID: String)
    case syncOrder(draftID: String)
}

/// Decides the next step from a snapshot. Pure, so every rule is unit-tested without a server.
///
/// Byte transfers start first so they run while the queue sends the API calls one at a time. Server
/// removals run before attaches, because the server limits how many photos an item has. A
/// row that failed waits for its `retryAt`, and one whose retries stopped waits for the user. With
/// nobody signed in, only on-device work (tag reading) runs.
enum UploadPlanner {
    static func next(
        in snapshot: UploadSnapshot,
        now: Date,
        transferring: Set<String>,
        signedIn: Bool,
    ) -> UploadWork? {
        let drafts = Dictionary(uniqueKeysWithValues: snapshot.drafts.map { ($0.id, $0) })
        let photos = snapshot.photos.filter { $0.retry.isRunnable(at: now) && !transferring.contains($0.id) }
        let network = signedIn ? nextNetworkWork(snapshot, drafts: drafts, photos: photos, now: now) : nil
        return network ?? photos.first(where: needsTagRead).map { .readTag(photoID: $0.id) }
    }

    /// The earliest time after `now` a waiting row becomes runnable again. A row whose time has
    /// passed but that `next` did not pick is blocked (no sign-in, or an earlier step), and a
    /// sign-in or an edit wakes the queue for it.
    static func nextRetry(in snapshot: UploadSnapshot, now: Date) -> Date? {
        let states = snapshot.drafts.map(\.retry) + snapshot.photos.map(\.retry) + snapshot.deletions.map(\.retry)
        return states.filter { $0.failure == nil }.compactMap(\.retryAt).filter { $0 > now }.min()
    }

    private static func nextNetworkWork(
        _ snapshot: UploadSnapshot,
        drafts: [String: DraftRecord],
        photos: [DraftPhotoRecord],
        now: Date,
    ) -> UploadWork? {
        if let photo = photos.first(where: { $0.step == .transfer }) {
            let usable = photo.target?.isUsable(at: now) ?? false
            return usable ? .startTransfer(photoID: photo.id) : .refreshTarget(photoID: photo.id)
        }
        if let photo = photos.first(where: { $0.step == .session }) {
            return .createSession(photoID: photo.id)
        }
        let runnableDrafts = snapshot.drafts.filter { $0.retry.isRunnable(at: now) }
        if let draft = runnableDrafts.first(where: { $0.serverItemID == nil }) {
            return .createItem(draftID: draft.id)
        }
        if let deletion = snapshot.deletions.first(where: { $0.retry.isRunnable(at: now) }) {
            return .deleteOnServer(deletionID: deletion.id)
        }
        if let photo = photos.first(where: { photo in
            photo.step == .attach && drafts[photo.draftID]?.serverItemID != nil && !needsTagRead(photo)
        }) {
            return .attach(photoID: photo.id)
        }
        if let photo = photos.first(where: { $0.step == .done && $0.serverRole != $0.role }) {
            return .syncRole(photoID: photo.id)
        }
        if let draft = runnableDrafts.first(where: { needsOrderSync($0, snapshot) }) {
            return .syncOrder(draftID: draft.id)
        }
        return nil
    }

    private static func needsTagRead(_ photo: DraftPhotoRecord) -> Bool {
        photo.role == .tag && photo.tagReadState == .pending
    }

    /// The server's photo order is set once every photo is attached and no removed photo is still
    /// on the server, because `reorderItemPhotos` must list exactly the item's photos.
    private static func needsOrderSync(_ draft: DraftRecord, _ snapshot: UploadSnapshot) -> Bool {
        guard let itemID = draft.serverItemID else { return false }
        let photos = snapshot.photos.filter { $0.draftID == draft.id }
        guard !photos.isEmpty, photos.allSatisfy({ $0.step == .done && $0.serverPhotoID != nil }),
              !snapshot.deletions.contains(where: { $0.serverItemID == itemID }) else { return false }
        return photos.compactMap(\.serverPhotoID) != draft.syncedPhotoOrder
    }
}
