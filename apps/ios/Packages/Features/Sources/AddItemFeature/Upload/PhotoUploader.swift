import APIClient
import Core
import Foundation
import os

/// The upload queue: brings the server in line with the drafts on the phone and keeps going until
/// it is.
///
/// For each draft it creates the server item, and for each photo it runs the tag reader (tag
/// photos), requests an upload session, sends the bytes through ``UploadTransport`` (a background
/// URLSession in the app), and attaches the file to the item. Then it sends role and order changes
/// and removes what the user deleted. All progress is in the database, and every request has a
/// stored `Idempotency-Key`, so the queue resumes after a relaunch exactly where it stopped,
/// without creating anything twice. A failed request waits by ``RetryPolicy`` and, once retries
/// run out or the server says it cannot succeed, stops with a reason the user sees and a Retry.
///
/// Steps run one at a time, chosen by ``UploadPlanner``; byte transfers run concurrently in the
/// transport and report back through its events.
actor PhotoUploader {
    let store: DraftStore
    let api: UploadAPI
    let accessTokens: any AccessTokenProvider
    let tagReader: any TagReader
    let transport: any UploadTransport
    let policy: RetryPolicy
    let now: @Sendable () -> Date
    let activity: UploadActivity
    let log = Logger(subsystem: "com.listora.app", category: "uploads")

    /// Photos whose bytes are in flight in the transport.
    var transferring: Set<String> = []
    private var isSignedIn = false
    private var runTask: Task<Void, Never>?
    private var eventsTask: Task<Void, Never>?
    private var wakeContinuation: CheckedContinuation<Void, Never>?
    private var wakePending = false
    private var isIdle = false
    private var idleWaiters: [CheckedContinuation<Void, Never>] = []
    /// True when the transport delivered a system wake's events before anyone waited for them.
    private var backgroundEventsDelivered = false
    private var backgroundEventWaiters: [CheckedContinuation<Void, Never>] = []

    init(
        store: DraftStore,
        api: UploadAPI,
        accessTokens: any AccessTokenProvider,
        tagReader: any TagReader,
        transport: any UploadTransport,
        activity: UploadActivity,
        policy: RetryPolicy = .standard,
        now: @escaping @Sendable () -> Date = Date.init,
    ) {
        self.store = store
        self.api = api
        self.accessTokens = accessTokens
        self.tagReader = tagReader
        self.transport = transport
        self.activity = activity
        self.policy = policy
        self.now = now
    }

    /// Starts the queue; calling it again does nothing.
    func start() {
        guard runTask == nil else { return }
        let events = transport.events
        eventsTask = Task { [weak self] in
            for await event in events {
                await self?.handle(event)
            }
        }
        runTask = Task { [weak self] in
            await self?.run()
        }
    }

    /// Stops the queue. Transfers in flight continue in the transport.
    func stop() {
        runTask?.cancel()
        eventsTask?.cancel()
        runTask = nil
        eventsTask = nil
        wake()
    }

    /// Looks for work now: something changed (a new draft, an edit, a sign-in, a Retry).
    func wake() {
        isIdle = false
        if let continuation = wakeContinuation {
            wakeContinuation = nil
            continuation.resume()
        } else {
            wakePending = true
        }
    }

    /// Stops the transfers of photos the user removed.
    func cancelTransfers(of photoIDs: [String]) async {
        for photoID in photoIDs where transferring.contains(photoID) {
            await transport.cancel(photoID: photoID)
        }
    }

    /// Returns once the queue has nothing it can do right now (it may still be waiting for a
    /// retry, a transfer, or a sign-in).
    func waitUntilIdle() async {
        guard !isIdle else { return }
        await withCheckedContinuation { idleWaiters.append($0) }
    }

    /// For a system wake of the background session: returns once the transport has delivered the
    /// events the system woke the app for, every one of them is recorded, and the queue has acted
    /// on them (attached the uploaded photos).
    func finishBackgroundEvents() async {
        if backgroundEventsDelivered {
            backgroundEventsDelivered = false
        } else {
            await withCheckedContinuation { backgroundEventWaiters.append($0) }
        }
        wake()
        await waitUntilIdle()
    }

    // MARK: The loop

    private func run() async {
        transferring = await transport.activePhotoIDs()
        forgetTargetsOfInterruptedTransfers()
        while !Task.isCancelled {
            if await performNextStep() {
                continue
            }
            if wakePending {
                wakePending = false
                continue
            }
            setIdle(true)
            let nextRetry = (try? store.uploadSnapshot()).flatMap { UploadPlanner.nextRetry(in: $0, now: now()) }
            await sleep(until: nextRetry)
            setIdle(false)
        }
    }

    /// A photo left mid-transfer with no transfer running (the app was terminated, or the user
    /// force-quit it, which cancels background transfers) first asks its session what arrived, so
    /// bytes that finished while the app was away are not sent again.
    private func forgetTargetsOfInterruptedTransfers() {
        guard let photos = try? store.uploadSnapshot().photos else { return }
        for photo in photos where photo.step == .transfer && photo.target != nil && !transferring.contains(photo.id) {
            _ = try? store.updatePhoto(photo.id) { record in
                guard record.step == .transfer else { return }
                record.target = nil
            }
        }
    }

    /// Runs one step; false when there is nothing to do now.
    private func performNextStep() async -> Bool {
        isSignedIn = await accessTokens.accessToken() != nil
        await publish()
        let snapshot: UploadSnapshot
        do {
            snapshot = try store.uploadSnapshot()
        } catch {
            log.error("Reading the upload queue failed: \(String(describing: error), privacy: .public)")
            return false
        }
        guard let work = UploadPlanner.next(
            in: snapshot,
            now: now(),
            transferring: transferring,
            signedIn: isSignedIn,
        ) else { return false }
        do {
            try await perform(work, in: snapshot)
        } catch {
            // Only a local database or file failure lands here; requests record their own failures.
            log.error("Upload step failed: \(String(describing: error), privacy: .public)")
            try? await Task.sleep(for: policy.baseDelay)
        }
        return true
    }

    private func perform(_ work: UploadWork, in snapshot: UploadSnapshot) async throws {
        let photos = Dictionary(uniqueKeysWithValues: snapshot.photos.map { ($0.id, $0) })
        let drafts = Dictionary(uniqueKeysWithValues: snapshot.drafts.map { ($0.id, $0) })
        switch work {
        case let .readTag(photoID):
            try await readTag(of: photos[photoID])
        case let .createSession(photoID):
            try await createSession(for: photos[photoID])
        case let .refreshTarget(photoID):
            try await refreshTarget(of: photos[photoID])
        case let .startTransfer(photoID):
            await startTransfer(of: photos[photoID])
        case let .createItem(draftID):
            try await createItem(for: drafts[draftID])
        case let .attach(photoID):
            try await attach(photos[photoID], to: photos[photoID].flatMap { drafts[$0.draftID] })
        case let .deleteOnServer(deletionID):
            try await deleteOnServer(snapshot.deletions.first { $0.id == deletionID })
        case let .syncRole(photoID):
            try await syncRole(of: photos[photoID], in: photos[photoID].flatMap { drafts[$0.draftID] })
        case let .syncOrder(draftID):
            if let draft = drafts[draftID] {
                try await syncOrder(of: draft, photos: snapshot.photos.filter { $0.draftID == draftID })
            }
        }
    }

    private func sleep(until date: Date?) async {
        let timer = date.map { date in
            let delay = max(0, date.timeIntervalSince(now()))
            return Task { [weak self] in
                try? await Task.sleep(for: .seconds(delay))
                await self?.wake()
            }
        }
        await withCheckedContinuation { wakeContinuation = $0 }
        timer?.cancel()
    }

    private func setIdle(_ idle: Bool) {
        isIdle = idle
        guard idle else { return }
        let waiters = idleWaiters
        idleWaiters = []
        for waiter in waiters {
            waiter.resume()
        }
    }

    func backgroundEventsWereDelivered() {
        guard !backgroundEventWaiters.isEmpty else {
            backgroundEventsDelivered = true
            return
        }
        let waiters = backgroundEventWaiters
        backgroundEventWaiters = []
        for waiter in waiters {
            waiter.resume()
        }
    }

    func publish() async {
        let signedIn = isSignedIn
        let transferring = transferring
        await activity.update(isSignedIn: signedIn, transferring: transferring)
    }

    // MARK: Recording failures

    /// Records a failed request of a photo: waits by the policy, or stops with the reason. A `401`
    /// is not counted: the token is gone, and the photo waits for the next sign-in.
    /// `setsBack`: the failure sends the photo back to an earlier step, which sends new requests,
    /// so it is retried even when the server called it final; it keeps counting toward the policy's
    /// limit after that step succeeds again.
    func recordPhotoFailure(
        _ photoID: String,
        _ failure: APIFailure,
        setsBack: Bool = false,
        also change: @escaping @Sendable (inout DraftPhotoRecord) -> Void = { _ in },
    ) {
        let next = retryUpdate(for: failure, stops: true, setsBack: setsBack)
        _ = try? store.updatePhoto(photoID) { photo in
            change(&photo)
            photo.retry = next(photo.retry)
        }
    }

    func recordDraftFailure(_ draftID: String, _ failure: APIFailure) {
        let next = retryUpdate(for: failure, stops: true)
        _ = try? store.updateDraft(draftID) { $0.retry = next($0.retry) }
    }

    /// Deletions never stop: they keep retrying at the longest delay until the server confirms.
    func recordDeletionFailure(_ deletionID: String, _ failure: APIFailure) {
        let next = retryUpdate(for: failure, stops: false)
        try? store.updateDeletion(deletionID) { $0.retry = next($0.retry) }
    }

    private func retryUpdate(
        for failure: APIFailure,
        stops: Bool,
        setsBack: Bool = false,
    ) -> @Sendable (RetryState) -> RetryState {
        let policy = policy
        let now = now()
        return { state in
            var state = state
            guard !failure.isUnauthenticated else {
                state.retryAt = now.addingTimeInterval(policy.baseDelay.timeInterval)
                return state
            }
            state.attempt += 1
            if setsBack {
                state.setbacks += 1
            }
            if stops, !(failure.retryable || setsBack) || state.attempt >= policy.maxAttempts {
                state.failure = failure.message
                state.retryAt = nil
            } else {
                let delay = policy.delay(afterAttempt: state.attempt, retryAfter: failure.retryAfter)
                state.retryAt = now.addingTimeInterval(delay.timeInterval)
            }
            return state
        }
    }
}

extension Duration {
    var timeInterval: TimeInterval {
        TimeInterval(components.seconds) + TimeInterval(components.attoseconds) / 1e18
    }
}
