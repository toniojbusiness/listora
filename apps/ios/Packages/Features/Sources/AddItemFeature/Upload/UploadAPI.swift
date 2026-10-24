import APIClient
import Foundation
import ListoraAPI

/// One file of an upload session, as the queue needs it.
struct UploadFileState: Equatable, Sendable {
    enum Status: Equatable, Sendable {
        case pending
        case uploaded
        case attached
    }

    let id: String
    let status: Status
    /// Present only while `pending` and the session lasts.
    let target: UploadTarget?
}

/// The API calls of the upload queue, over the generated client, returning plain values and
/// throwing ``APIFailure`` for every other answer.
struct UploadAPI: Sendable {
    let client: Client

    func createItem(idempotencyKey: String) async throws(APIFailure) -> (id: String, sku: String) {
        let output = try await call {
            try await client.createItem(headers: .init(idempotencyKey: idempotencyKey), body: .json(.init()))
        }
        switch output {
        case let .created(created):
            let item = try body { try created.body.json }
            return (item.id, item.sku)
        case let .unprocessableContent(response):
            throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func createUploadSession(
        idempotencyKey: String,
        byteSize: Int,
        sha256: String,
    ) async throws(APIFailure) -> (sessionID: String, file: UploadFileState) {
        let file = Components.Schemas.UploadFileCreate(
            contentType: .imageJpeg,
            byteSize: Int64(byteSize),
            sha256: sha256,
        )
        let output = try await call {
            try await client.createUploadSession(
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(.init(files: [file])),
            )
        }
        switch output {
        case let .created(created):
            let session = try body { try created.body.json }
            guard let file = session.files.first else { throw APIFailure(Unreadable()) }
            return try (session.id, Self.state(of: file))
        case let .contentTooLarge(response):
            throw APIFailure(statusCode: 413, response: response)
        case let .unprocessableContent(response):
            throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    /// The session's files, or nil when the session no longer exists.
    func uploadSession(id: String) async throws(APIFailure) -> [UploadFileState]? {
        let output = try await call { try await client.getUploadSession(path: .init(sessionId: id)) }
        switch output {
        case let .ok(response):
            let session = try body { try response.body.json }
            var files: [UploadFileState] = []
            for file in session.files {
                try files.append(Self.state(of: file))
            }
            return files
        case .notFound:
            return nil
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    /// Attaches the uploaded file; returns the new photo's id.
    func attachPhoto(
        itemID: String,
        idempotencyKey: String,
        request: AttachRequest,
    ) async throws(APIFailure) -> String {
        let reads = request.tagReads
        let photo = Components.Schemas.PhotoCreate(
            uploadFileId: request.uploadFileID,
            role: request.role.contract,
            width: Int32(request.width),
            height: Int32(request.height),
            ocrLines: reads?.ocrLines.map { .init(text: $0.text, confidence: $0.confidence) },
            barcodes: reads?.barcodes.map { .init(symbology: $0.symbology, payload: $0.payload) },
        )
        let output = try await call {
            try await client.addItemPhoto(
                path: .init(itemId: itemID),
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(photo),
            )
        }
        switch output {
        case let .created(created):
            return try body { try created.body.json }.id
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response):
            throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response):
            throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func updateRole(itemID: String, photoID: String, role: PhotoRole) async throws(APIFailure) {
        let output = try await call {
            try await client.updateItemPhoto(
                path: .init(itemId: itemID, photoId: photoID),
                body: .json(.init(role: role.contract)),
            )
        }
        switch output {
        case .ok:
            return
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .unprocessableContent(response):
            throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    /// The item's photos in the server's order: id and SHA-256.
    func photos(itemID: String) async throws(APIFailure) -> [(id: String, sha256: String)] {
        let output = try await call { try await client.getItem(path: .init(itemId: itemID)) }
        switch output {
        case let .ok(response):
            return try body { try response.body.json }.photos.map { ($0.id, $0.sha256) }
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func reorderPhotos(itemID: String, photoIDs: [String]) async throws(APIFailure) {
        let output = try await call {
            try await client.reorderItemPhotos(path: .init(itemId: itemID), body: .json(.init(photoIds: photoIDs)))
        }
        switch output {
        case .ok:
            return
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .unprocessableContent(response):
            throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    /// Removes a photo; a photo that is already gone counts as removed.
    func deletePhoto(itemID: String, photoID: String) async throws(APIFailure) {
        let output = try await call {
            try await client.deleteItemPhoto(path: .init(itemId: itemID, photoId: photoID))
        }
        switch output {
        case .noContent, .notFound:
            return
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    /// Deletes an item; an item that is already gone counts as deleted.
    func deleteItem(itemID: String) async throws(APIFailure) {
        let output = try await call { try await client.deleteItem(path: .init(itemId: itemID)) }
        switch output {
        case .noContent, .notFound:
            return
        case let .conflict(response):
            throw APIFailure(statusCode: 409, response: response)
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    // MARK: Helpers

    private struct Unreadable: Error {}

    private func call<Output>(_ request: () async throws -> Output) async throws(APIFailure) -> Output {
        do {
            return try await request()
        } catch {
            throw APIFailure(error)
        }
    }

    private func body<Body>(_ read: () throws -> Body) throws(APIFailure) -> Body {
        do {
            return try read()
        } catch {
            throw APIFailure(error)
        }
    }

    private static func state(of file: Components.Schemas.UploadFile) throws(APIFailure) -> UploadFileState {
        let status: UploadFileState.Status = switch file.status {
        case .pending: .pending
        case .uploaded: .uploaded
        case .attached: .attached
        }
        var target: UploadTarget?
        if let upload = file.upload {
            guard let url = URL(string: upload.url) else { throw APIFailure(Unreadable()) }
            target = UploadTarget(
                url: url,
                headers: upload.headers.map { .init(name: $0.name, value: $0.value) },
                expiresAt: upload.expiresAt,
            )
        }
        return UploadFileState(id: file.id, status: status, target: target)
    }
}
