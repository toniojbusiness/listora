import Foundation
import Testing
@testable import AddItemFeature

struct UploadPlannerTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func draft(_ id: String = "d1", itemID: String? = "item-1", order: [String]? = nil) -> DraftRecord {
        var draft = DraftRecord.new(now: now)
        draft.id = id
        draft.serverItemID = itemID
        draft.syncedPhotoOrder = order
        return draft
    }

    private func photo(
        _ id: String,
        draftID: String = "d1",
        position: Int = 0,
        role: PhotoRole = .front,
        step: UploadStep = .session,
    ) throws -> DraftPhotoRecord {
        var photo = try DraftPhotoRecord.new(
            draftID: draftID,
            position: position,
            role: role,
            photo: TestImages.prepared(),
            now: now,
        )
        photo.id = id
        photo.step = step
        if step == .done {
            photo.serverPhotoID = "server-\(id)"
            photo.serverRole = role
        }
        return photo
    }

    private func next(
        _ snapshot: UploadSnapshot,
        transferring: Set<String> = [],
        signedIn: Bool = true,
    ) -> UploadWork? {
        UploadPlanner.next(in: snapshot, now: now, transferring: transferring, signedIn: signedIn)
    }

    @Test
    func `byte transfers start before anything else, with a usable target`() throws {
        var transfer = try photo("p2", position: 1, step: .transfer)
        transfer.target = UploadTarget(
            url: URL(filePath: "/upload"),
            headers: [],
            expiresAt: now.addingTimeInterval(600),
        )
        let snapshot = try UploadSnapshot(
            drafts: [draft(itemID: nil)],
            photos: [photo("p1", step: .session), transfer],
            deletions: [],
        )

        #expect(next(snapshot) == .startTransfer(photoID: "p2"))
    }

    @Test
    func `an expiring target is refreshed instead of used`() throws {
        var transfer = try photo("p1", step: .transfer)
        transfer.target = UploadTarget(
            url: URL(filePath: "/upload"),
            headers: [],
            expiresAt: now.addingTimeInterval(30),
        )

        #expect(next(UploadSnapshot(drafts: [draft()], photos: [transfer], deletions: [])) ==
            .refreshTarget(photoID: "p1"))
    }

    @Test
    func `photos in flight are left alone`() throws {
        var transfer = try photo("p1", step: .transfer)
        transfer.target = UploadTarget(
            url: URL(filePath: "/upload"),
            headers: [],
            expiresAt: now.addingTimeInterval(600),
        )
        let snapshot = UploadSnapshot(drafts: [draft()], photos: [transfer], deletions: [])

        #expect(next(snapshot, transferring: ["p1"]) == nil)
    }

    @Test
    func `sessions come before the item, and the item before attaching`() throws {
        let snapshot = try UploadSnapshot(
            drafts: [draft(itemID: nil)],
            photos: [photo("p1", step: .attach), photo("p2", position: 1, step: .session)],
            deletions: [],
        )

        #expect(next(snapshot) == .createSession(photoID: "p2"))
        let withoutSession = UploadSnapshot(drafts: snapshot.drafts, photos: [snapshot.photos[0]], deletions: [])
        #expect(next(withoutSession) == .createItem(draftID: "d1"))
        let withItem = UploadSnapshot(drafts: [draft()], photos: [snapshot.photos[0]], deletions: [])
        #expect(next(withItem) == .attach(photoID: "p1"))
    }

    @Test
    func `a tag photo is read on the device before it is attached`() throws {
        let tag = try photo("p1", role: .tag, step: .attach)
        let snapshot = UploadSnapshot(drafts: [draft()], photos: [tag], deletions: [])

        #expect(next(snapshot) == .readTag(photoID: "p1"))
        var read = tag
        read.tagReadState = .done
        #expect(try next(UploadSnapshot(drafts: [draft()], photos: [read], deletions: [])) == .attach(photoID: "p1"))
    }

    @Test
    func `signed out, only on-device work runs`() throws {
        let snapshot = try UploadSnapshot(
            drafts: [draft(itemID: nil)],
            photos: [photo("p1", step: .session), photo("p2", position: 1, role: .tag)],
            deletions: [],
        )

        #expect(next(snapshot, signedIn: false) == .readTag(photoID: "p2"))
        var read = snapshot
        read.photos[1].tagReadState = .done
        #expect(next(read, signedIn: false) == nil)
    }

    @Test
    func `a row waiting for its retry, or stopped, is skipped`() throws {
        var waiting = try photo("p1")
        waiting.retry = RetryState(attempt: 1, retryAt: now.addingTimeInterval(5))
        var stopped = try photo("p2", position: 1)
        stopped.retry = RetryState(attempt: 8, failure: "Listora is busy.")
        let snapshot = UploadSnapshot(drafts: [draft()], photos: [waiting, stopped], deletions: [])

        #expect(next(snapshot) == nil)
        #expect(UploadPlanner.nextRetry(in: snapshot, now: now) == now.addingTimeInterval(5))
        waiting.retry.retryAt = now
        #expect(next(UploadSnapshot(drafts: snapshot.drafts, photos: [waiting, stopped], deletions: [])) ==
            .createSession(photoID: "p1"))
    }

    @Test
    func `a retry time that has passed is no reason to wake, so a blocked row does not spin the queue`() throws {
        var signedOut = try photo("p1")
        signedOut.retry = RetryState(attempt: 0, retryAt: now.addingTimeInterval(-2))
        var draft = draft(itemID: nil)
        draft.retry = RetryState(attempt: 1, retryAt: now.addingTimeInterval(-1))
        let snapshot = UploadSnapshot(drafts: [draft], photos: [signedOut], deletions: [])

        #expect(next(snapshot, signedIn: false) == nil)
        #expect(UploadPlanner.nextRetry(in: snapshot, now: now) == nil)
    }

    @Test
    func `removed photos are deleted on the server before new ones are attached`() throws {
        let replacement = try photo("p1", step: .attach)
        let deletion = ServerDeletionRecord(
            id: "x1",
            kind: .photo,
            createdAt: now,
            serverItemID: "item-1",
            serverPhotoID: "server-old",
        )

        #expect(try next(UploadSnapshot(drafts: [draft()], photos: [replacement], deletions: [deletion])) ==
            .deleteOnServer(deletionID: "x1"))
        #expect(try next(UploadSnapshot(drafts: [draft()], photos: [replacement], deletions: [])) ==
            .attach(photoID: "p1"))
    }

    @Test
    func `a changed role is sent after the photo is attached`() throws {
        var changed = try photo("p1", role: .back, step: .done)
        changed.role = .flaw

        #expect(try next(UploadSnapshot(drafts: [draft()], photos: [changed], deletions: [])) ==
            .syncRole(photoID: "p1"))
    }

    @Test
    func `the order is sent once every photo is attached and no removed photo is still on the server`() throws {
        let photos = try [photo("p1", step: .done), photo("p2", position: 1, step: .done)]
        let deletion = ServerDeletionRecord(
            id: "x1",
            kind: .photo,
            createdAt: now,
            serverItemID: "item-1",
            serverPhotoID: "server-old",
        )

        #expect(next(UploadSnapshot(drafts: [draft()], photos: photos, deletions: [deletion])) ==
            .deleteOnServer(deletionID: "x1"))
        #expect(next(UploadSnapshot(drafts: [draft()], photos: photos, deletions: [])) == .syncOrder(draftID: "d1"))
        let synced = draft(order: ["server-p1", "server-p2"])
        #expect(next(UploadSnapshot(drafts: [synced], photos: photos, deletions: [])) == nil)
        let reordered = draft(order: ["server-p2", "server-p1"])
        #expect(next(UploadSnapshot(drafts: [reordered], photos: photos, deletions: [])) == .syncOrder(draftID: "d1"))
    }
}

struct RetryPolicyTests {
    private func seconds(_ duration: Duration) -> Double {
        duration.timeInterval
    }

    @Test
    func `delays double from the base and stop growing at the maximum`() {
        let policy = RetryPolicy.standard
        let delays = (1 ... 9).map { seconds(policy.delay(afterAttempt: $0, random: 0.5)) }

        for (delay, expected) in zip(delays, [2.0, 4, 8, 16, 32, 64, 128, 256, 300]) {
            #expect(abs(delay - expected) < 1e-6, "\(delay) is not \(expected)")
        }
    }

    @Test
    func `jitter spreads each delay within its range`() {
        let policy = RetryPolicy.standard

        #expect(abs(seconds(policy.delay(afterAttempt: 3, random: 0)) - 6.4) < 1e-6)
        #expect(abs(seconds(policy.delay(afterAttempt: 3, random: 1)) - 9.6) < 1e-6)
    }

    @Test
    func `the server's Retry-After is a minimum`() {
        #expect(abs(seconds(RetryPolicy.standard.delay(afterAttempt: 1, retryAfter: .seconds(30), random: 0.5)) - 30) <
            1e-6)
        #expect(abs(seconds(RetryPolicy.standard.delay(afterAttempt: 5, retryAfter: .seconds(1), random: 0.5)) - 32) <
            1e-6)
    }
}
