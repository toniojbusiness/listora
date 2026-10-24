import APIClient
import Core
import Foundation

/// The steps ``UploadPlanner`` chooses. Each one sends at most one request (two for the order
/// sync), then records the result or the failure, so the next pass sees progress either way.
/// Writes check that the row is still in the state the step started from: the user may have
/// edited or removed it while the request ran.
extension PhotoUploader {
    func readTag(of photo: DraftPhotoRecord?) async throws {
        guard let photo else { return }
        let reads: PhotoTagReadUpload?
        do {
            reads = try await tagReader.read(imageData: store.imageData(of: photo)).upload
        } catch is CancellationError {
            return
        } catch {
            // The photo still uploads; the server just has no tag text for it.
            log.error("Tag reading failed for a photo: \(String(describing: error), privacy: .public)")
            reads = nil
        }
        try store.updatePhoto(photo.id) { record in
            guard record.tagReadState == .pending else { return }
            record.tagReadState = reads == nil ? .failed : .done
            record.tagReads = reads
        }
    }

    func createSession(for photo: DraftPhotoRecord?) async throws {
        guard let photo else { return }
        let session: (sessionID: String, file: UploadFileState)
        do {
            session = try await api.createUploadSession(
                idempotencyKey: photo.sessionKey,
                byteSize: photo.byteSize,
                sha256: photo.sha256,
            )
        } catch {
            recordPhotoFailure(photo.id, error)
            return
        }
        let key = photo.sessionKey
        try store.updatePhoto(photo.id) { record in
            guard record.step == .session, record.sessionKey == key else { return }
            record.sessionID = session.sessionID
            record.uploadFileID = session.file.id
            record.target = session.file.target
            record.step = session.file.status == .pending ? .transfer : .attach
            record.retry.retryAt = nil
        }
    }

    func refreshTarget(of photo: DraftPhotoRecord?) async throws {
        guard let photo else { return }
        guard let sessionID = photo.sessionID, let fileID = photo.uploadFileID else {
            try store.updatePhoto(photo.id) { $0.restartUpload() }
            return
        }
        let file: UploadFileState?
        do {
            file = try await api.uploadSession(id: sessionID)?.first { $0.id == fileID }
        } catch {
            recordPhotoFailure(photo.id, error)
            return
        }
        try store.updatePhoto(photo.id) { record in
            guard record.step == .transfer, record.sessionID == sessionID else { return }
            switch file?.status {
            case .pending:
                // A pending file without a target belongs to an expired session.
                if let target = file?.target {
                    record.target = target
                } else {
                    record.restartUpload()
                }
            case .uploaded, .attached:
                // The bytes arrived, perhaps while the app was not running.
                record.step = .attach
                record.target = nil
            case nil:
                record.restartUpload()
            }
        }
    }

    func createItem(for draft: DraftRecord?) async throws {
        guard let draft else { return }
        // Recorded before sending: if the answer is lost and the user deletes the draft, the
        // deletion replays this request to find the item.
        guard try store.updateDraft(draft.id, { $0.createItemSent = true }) != nil else { return }
        let item: (id: String, sku: String)
        do {
            item = try await api.createItem(idempotencyKey: draft.createItemKey)
        } catch {
            recordDraftFailure(draft.id, error)
            return
        }
        try store.updateDraft(draft.id) { record in
            record.serverItemID = item.id
            record.sku = item.sku
            record.retry = RetryState()
        }
    }

    func attach(_ photo: DraftPhotoRecord?, to draft: DraftRecord?) async throws {
        guard let photo, let itemID = draft?.serverItemID else { return }
        guard let fileID = photo.uploadFileID else {
            try store.updatePhoto(photo.id) { $0.restartUpload() }
            return
        }
        let request = photo.attachRequest ?? AttachRequest(
            uploadFileID: fileID,
            role: photo.role,
            width: photo.width,
            height: photo.height,
            tagReads: photo.role == .tag ? photo.tagReads : nil,
        )
        let key = photo.attachKey
        if photo.attachRequest == nil {
            // Fixed before sending, so a retry with the same key sends the same body.
            let saved = try store.updatePhoto(photo.id) { record in
                guard record.step == .attach, record.attachKey == key, record.attachRequest == nil else { return }
                record.attachRequest = request
            }
            guard saved?.attachRequest == request else { return }
        }
        let serverPhotoID: String
        do {
            serverPhotoID = try await api.attachPhoto(itemID: itemID, idempotencyKey: key, request: request)
        } catch {
            await attachFailed(photo, itemID: itemID, key: key, failure: error)
            return
        }
        try store.updatePhoto(photo.id) { record in
            guard record.attachKey == key else { return }
            record.serverPhotoID = serverPhotoID
            record.serverRole = request.role
            record.step = .done
            record.target = nil
            record.retry = RetryState()
        }
    }

    private func attachFailed(_ photo: DraftPhotoRecord, itemID: String, key: String, failure: APIFailure) async {
        switch failure.knownCode {
        case .uploadIncomplete:
            // The bytes did not all arrive: send them again.
            recordPhotoFailure(photo.id, failure) { record in
                guard record.attachKey == key else { return }
                record.step = .transfer
                record.target = nil
            }
        case .uploadExpired, .notFound:
            // The session expired or its file is gone; nothing was attached.
            recordPhotoFailure(photo.id, failure) { record in
                guard record.attachKey == key else { return }
                record.restartUpload()
            }
        case .alreadyExists:
            await adoptAttachedPhoto(photo, itemID: itemID, key: key, failure: failure)
        case .idempotencyKeyReused:
            recordPhotoFailure(photo.id, failure) { record in
                guard record.attachKey == key else { return }
                record.attachKey = UUID().uuidString.lowercased()
                record.attachRequest = nil
            }
        default:
            recordPhotoFailure(photo.id, failure)
        }
    }

    /// The file is already attached, but this key's stored answer is gone (it is kept 24 hours):
    /// find the photo by its SHA-256 instead of attaching twice.
    private func adoptAttachedPhoto(
        _ photo: DraftPhotoRecord,
        itemID: String,
        key: String,
        failure: APIFailure,
    ) async {
        let match: (id: String, sha256: String)?
        do {
            match = try await api.photos(itemID: itemID).first { $0.sha256 == photo.sha256 }
        } catch {
            recordPhotoFailure(photo.id, error)
            return
        }
        guard let match else {
            recordPhotoFailure(photo.id, failure) { $0.restartUpload() }
            return
        }
        let role = photo.attachRequest?.role ?? photo.role
        _ = try? store.updatePhoto(photo.id) { record in
            guard record.attachKey == key else { return }
            record.serverPhotoID = match.id
            record.serverRole = role
            record.step = .done
            record.retry = RetryState()
        }
    }

    func syncRole(of photo: DraftPhotoRecord?, in draft: DraftRecord?) async throws {
        guard let photo, let itemID = draft?.serverItemID, let serverPhotoID = photo.serverPhotoID else { return }
        let role = photo.role
        do {
            try await api.updateRole(itemID: itemID, photoID: serverPhotoID, role: role)
        } catch {
            // A photo the server no longer has uploads again.
            let gone = error.statusCode == 404
            recordPhotoFailure(photo.id, error) { record in
                if gone {
                    record.restartUpload()
                }
            }
            return
        }
        try store.updatePhoto(photo.id) { record in
            guard record.serverPhotoID == serverPhotoID else { return }
            record.serverRole = role
            record.retry.retryAt = nil
        }
    }

    func syncOrder(of draft: DraftRecord, photos: [DraftPhotoRecord]) async throws {
        guard let itemID = draft.serverItemID else { return }
        let local = photos.sorted { $0.position < $1.position }.compactMap(\.serverPhotoID)
        let server: [String]
        do {
            server = try await api.photos(itemID: itemID).map(\.id)
        } catch {
            recordDraftFailure(draft.id, error)
            return
        }
        let missing = Set(local).subtracting(server)
        guard missing.isEmpty else {
            // Photos removed elsewhere upload again, then the order is sent.
            for photo in photos where photo.serverPhotoID.map(missing.contains) ?? false {
                try store.updatePhoto(photo.id) { $0.restartUpload() }
            }
            return
        }
        // Photos this phone does not know (added elsewhere) keep their place at the end.
        let order = local + server.filter { !local.contains($0) }
        do {
            try await api.reorderPhotos(itemID: itemID, photoIDs: order)
        } catch {
            recordDraftFailure(draft.id, error)
            return
        }
        try store.updateDraft(draft.id) { record in
            record.syncedPhotoOrder = local
            record.retry = RetryState()
        }
    }

    func deleteOnServer(_ deletion: ServerDeletionRecord?) async throws {
        guard let deletion else { return }
        do {
            switch deletion.kind {
            case .item:
                try await deleteItem(deletion)
            case .photo:
                try await deletePhoto(deletion)
            }
        } catch {
            recordDeletionFailure(deletion.id, error)
        }
    }

    private func deleteItem(_ deletion: ServerDeletionRecord) async throws(APIFailure) {
        if let itemID = deletion.serverItemID {
            try await api.deleteItem(itemID: itemID)
            try? store.removeDeletion(deletion.id)
        } else if let key = deletion.createItemKey {
            // Replaying the create returns the item it made, or makes it now; either way the next
            // pass deletes it by id.
            let item = try await api.createItem(idempotencyKey: key)
            try? store.updateDeletion(deletion.id) { $0.serverItemID = item.id }
        } else {
            try? store.removeDeletion(deletion.id)
        }
    }

    private func deletePhoto(_ deletion: ServerDeletionRecord) async throws(APIFailure) {
        guard let itemID = deletion.serverItemID else {
            try? store.removeDeletion(deletion.id)
            return
        }
        if let photoID = deletion.serverPhotoID {
            try await api.deletePhoto(itemID: itemID, photoID: photoID)
            try? store.removeDeletion(deletion.id)
        } else if let key = deletion.attachKey, let request = deletion.attachRequest {
            do {
                let photoID = try await api.attachPhoto(itemID: itemID, idempotencyKey: key, request: request)
                try? store.updateDeletion(deletion.id) { $0.serverPhotoID = photoID }
            } catch where !error.retryable && !error.isUnauthenticated {
                // The attach cannot succeed (expired, gone, or invalid), so nothing is on the server.
                try? store.removeDeletion(deletion.id)
            }
        } else {
            try? store.removeDeletion(deletion.id)
        }
    }
}
