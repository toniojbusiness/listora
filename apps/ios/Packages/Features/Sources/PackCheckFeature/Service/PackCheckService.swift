import APIClient
import Foundation
import ListoraAPI

typealias PackOrder = Components.Schemas.PackOrder
typealias PackItem = Components.Schemas.PackItem
typealias PackScan = Components.Schemas.PackScan

/// Pack check's calls (docs/features/pack-check.md), returning the contract's types and throwing
/// ``APIFailure`` for every other answer. A protocol so the models' tests run against a fake.
protocol PackCheckService: Sendable {
    func isEnabled() async throws(APIFailure) -> Bool
    func setEnabled(_ enabled: Bool) async throws(APIFailure) -> Bool
    /// The to-ship list (`listPackOrders`).
    func orders() async throws(APIFailure) -> [PackOrder]
    /// Asks for label reads; returns how many orders' labels will be read.
    func refreshLabels() async throws(APIFailure) -> Int
    /// What a scan means for the order being packed (`checkPackScan`); only reads.
    func check(label: String?, sticker: String?, saleID: String?) async throws(APIFailure) -> PackScan
    func pack(
        saleID: String,
        label: String,
        sticker: String?,
        photoCheck: Bool,
        idempotencyKey: String,
    ) async throws(APIFailure) -> PackOrder
    func unpack(saleID: String) async throws(APIFailure) -> PackOrder
    /// Records that this phone printed the order's label (`recordLabelPrint`), so the next print
    /// of it warns first.
    func recordLabelPrint(saleID: String, trackingNumber: String, idempotencyKey: String) async throws(APIFailure)
        -> PackOrder
    /// Uploads the package photo (a JPEG without metadata) and keeps it with the order; the keys
    /// are kept for every retry of the same photo, so it is never uploaded or kept twice.
    func addPhoto(saleID: String, jpeg: Data, keys: PackPhotoKeys) async throws(APIFailure) -> PackOrder
    func removePhoto(saleID: String) async throws(APIFailure) -> PackOrder
}

/// The `Idempotency-Key`s of one package photo: its upload session, and keeping it.
struct PackPhotoKeys: Equatable, Sendable {
    var upload = UUID().uuidString
    var attach = UUID().uuidString
}

/// ``PackCheckService`` over the generated client. `uploads` sends the photo's bytes to storage.
struct APIPackCheckService: PackCheckService {
    let client: Client
    var uploads: URLSession = .shared

    func isEnabled() async throws(APIFailure) -> Bool {
        switch try await call({ try await client.getPackCheckSettings() }) {
        case let .ok(response): try body { try response.body.json }.enabled
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func setEnabled(_ enabled: Bool) async throws(APIFailure) -> Bool {
        switch try await call({ try await client.replacePackCheckSettings(body: .json(.init(enabled: enabled))) }) {
        case let .ok(response): try body { try response.body.json }.enabled
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func orders() async throws(APIFailure) -> [PackOrder] {
        switch try await call({ try await client.listPackOrders() }) {
        case let .ok(response): try body { try response.body.json }.data
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func refreshLabels() async throws(APIFailure) -> Int {
        let output = try await call {
            try await client.refreshPackLabels(headers: .init(idempotencyKey: UUID().uuidString))
        }
        switch output {
        case let .ok(response): return try Int(body { try response.body.json }.orders)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func check(label: String?, sticker: String?, saleID: String?) async throws(APIFailure) -> PackScan {
        let output = try await call {
            try await client.checkPackScan(query: .init(label: label, sticker: sticker, saleId: saleID))
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func pack(
        saleID: String,
        label: String,
        sticker: String?,
        photoCheck: Bool,
        idempotencyKey: String,
    ) async throws(APIFailure) -> PackOrder {
        let output = try await call {
            try await client.packOrder(
                path: .init(saleId: saleID),
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(.init(label: label, sticker: sticker, photoCheck: photoCheck ? true : nil)),
            )
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func unpack(saleID: String) async throws(APIFailure) -> PackOrder {
        switch try await call({ try await client.unpackOrder(path: .init(saleId: saleID)) }) {
        case let .ok(response): try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func recordLabelPrint(
        saleID: String,
        trackingNumber: String,
        idempotencyKey: String,
    ) async throws(APIFailure) -> PackOrder {
        let output = try await call {
            try await client.recordLabelPrint(
                path: .init(saleId: saleID),
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(.init(trackingNumber: trackingNumber)),
            )
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func addPhoto(saleID: String, jpeg: Data, keys: PackPhotoKeys) async throws(APIFailure) -> PackOrder {
        let fileID = try await upload(jpeg, idempotencyKey: keys.upload)
        let output = try await call {
            try await client.addPackPhoto(
                path: .init(saleId: saleID),
                headers: .init(idempotencyKey: keys.attach),
                body: .json(.init(uploadFileId: fileID)),
            )
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func removePhoto(saleID: String) async throws(APIFailure) -> PackOrder {
        switch try await call({ try await client.removePackPhoto(path: .init(saleId: saleID)) }) {
        case let .ok(response): try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    /// An upload session of one JPEG, its bytes sent to the target; returns the file's id. The same
    /// `idempotencyKey` returns the same session, so a retry never uploads twice.
    private func upload(_ jpeg: Data, idempotencyKey: String) async throws(APIFailure) -> String {
        let file = Components.Schemas.UploadFileCreate(
            contentType: .imageJpeg,
            byteSize: Int64(jpeg.count),
            sha256: PackPhoto.sha256(jpeg),
        )
        let output = try await call {
            try await client.createUploadSession(
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(.init(files: [file])),
            )
        }
        let created: Components.Schemas.UploadFile
        switch output {
        case let .created(response):
            guard let first = try body({ try response.body.json }).files.first else { throw APIFailure(Unreadable()) }
            created = first
        case let .contentTooLarge(response): throw APIFailure(statusCode: 413, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
        guard let target = created.upload, let url = URL(string: target.url) else { return created.id }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        for header in target.headers {
            request.setValue(header.value, forHTTPHeaderField: header.name)
        }
        let status: Int
        do {
            let (_, response) = try await uploads.upload(for: request, from: jpeg)
            status = (response as? HTTPURLResponse)?.statusCode ?? 0
        } catch {
            throw .networkUnavailable
        }
        guard (200 ..< 300).contains(status) else {
            throw APIFailure(
                statusCode: status,
                code: "upload_failed",
                message: "The photo didn't upload. Try again.",
                retryable: true,
            )
        }
        return created.id
    }

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
}
