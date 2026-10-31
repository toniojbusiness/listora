import APIClient
import Foundation
import ListoraAPI

typealias ItemScan = Components.Schemas.ItemScan
typealias SourcingRunSummary = Components.Schemas.SourcingRunSummary

/// The thrift scan's calls (docs/features/thrift-scan.md): a run, each scan's read, and keeping
/// one, which the upload queue sends like an item's create.
extension UploadAPI {
    /// Starts a sourcing run at the place the seller named, if any; returns its id.
    func createSourcingRun(place: String?, idempotencyKey: String) async throws(APIFailure) -> String {
        let output = try await call {
            try await client.createSourcingRun(
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(.init(place: place)),
            )
        }
        switch output {
        case let .created(created):
            return try body { try created.body.json }.id
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .unprocessableContent(response):
            throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func endSourcingRun(runID: String, idempotencyKey: String) async throws(APIFailure) {
        let output = try await call {
            try await client.endSourcingRun(path: .init(runId: runID), headers: .init(idempotencyKey: idempotencyKey))
        }
        switch output {
        case .ok:
            return
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    /// Checks the run out at the register: its kept items become one haul of what the seller
    /// paid, and the answer is the run's summary with the estimated profit.
    func checkoutSourcingRun(
        runID: String,
        _ checkout: RunCheckout,
        idempotencyKey: String,
    ) async throws(APIFailure) -> SourcingRunSummary {
        let payload = Components.Schemas.SourcingRunCheckout(
            total: .init(amountCents: checkout.totalCents, currency: .usd),
            itemCount: Int32(clamping: checkout.itemCount),
            keptScanIds: checkout.keptScanIDs,
            place: checkout.place,
            purchaseDate: checkout.purchaseDate,
            miles: checkout.miles.map { Int32(clamping: $0) },
        )
        let output = try await call {
            try await client.checkoutSourcingRun(
                path: .init(runId: runID),
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(payload),
            )
        }
        switch output {
        case let .created(created):
            return try body { try created.body.json }
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

    /// Reads one scanned item: the AI's read, the household's own sales like it, and the call.
    func createScan(_ request: ScanRequest, idempotencyKey: String) async throws(APIFailure) -> ItemScan {
        let images = [Components.Schemas.ScanImage(role: .item, jpegBase64: request.itemJPEG.base64EncodedString())]
            + (request.tagJPEG.map { [Components.Schemas.ScanImage(role: .tag, jpegBase64: $0.base64EncodedString())] }
                ?? [])
        let payload = Components.Schemas.ScanCreate(
            runId: request.runID,
            images: images,
            note: request.note,
            tagText: request.tagText.isEmpty ? nil : request.tagText,
            replacesScanId: request.replacesScanID,
        )
        let output = try await call {
            try await client.createScan(headers: .init(idempotencyKey: idempotencyKey), body: .json(payload))
        }
        switch output {
        case let .created(created):
            return try body { try created.body.json }
        case let .forbidden(response):
            throw APIFailure(statusCode: 403, response: response)
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response):
            throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response):
            throw APIFailure(statusCode: 422, response: response)
        case let .tooManyRequests(response):
            throw APIFailure(statusCode: 429, response: response)
        case let .serviceUnavailable(response):
            throw APIFailure(statusCode: 503, response: response)
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    /// The scan looked up on the web: answered again with its research and the call made again.
    func researchScan(scanID: String, idempotencyKey: String) async throws(APIFailure) -> ItemScan {
        let output = try await call {
            try await client.researchScan(path: .init(scanId: scanID), headers: .init(idempotencyKey: idempotencyKey))
        }
        switch output {
        case let .ok(answer):
            return try body { try answer.body.json }
        case let .forbidden(response):
            throw APIFailure(statusCode: 403, response: response)
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .tooManyRequests(response):
            throw APIFailure(statusCode: 429, response: response)
        case let .serviceUnavailable(response):
            throw APIFailure(statusCode: 503, response: response)
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    /// The phone's answer to a comparison read of the scan (the runtime's JSON); answers the scan
    /// with the comparison in it and the call made again.
    func saveScanComparison(scanID: String, comparisonID: String, answer: Data) async throws(APIFailure) -> ItemScan {
        let decoded: Components.Schemas.ScanComparisonAnswer
        do {
            decoded = try JSONDecoder().decode(Components.Schemas.ScanComparisonAnswer.self, from: answer)
        } catch {
            // The runtime answered something the contract doesn't take: never sent as a read.
            throw APIFailure(
                statusCode: nil,
                code: "invalid_comparison",
                message: "Couldn't check prices on this item.",
                retryable: false,
            )
        }
        let output = try await call {
            try await client.saveScanComparison(
                path: .init(scanId: scanID, comparisonId: comparisonID),
                body: .json(decoded),
            )
        }
        switch output {
        case let .ok(answer):
            return try body { try answer.body.json }
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .unprocessableContent(response):
            throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    /// The kept scan's draft item: created now, or the one it was already kept as.
    func keepScan(scanID: String, idempotencyKey: String) async throws(APIFailure) -> (id: String, sku: String) {
        let output = try await call {
            try await client.keepScan(path: .init(scanId: scanID), headers: .init(idempotencyKey: idempotencyKey))
        }
        let item: Components.Schemas.Item
        switch output {
        case let .created(created):
            item = try body { try created.body.json }
        case let .ok(existing):
            item = try body { try existing.body.json }
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response):
            throw APIFailure(statusCode: 409, response: response)
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
        return (item.id, item.sku)
    }
}

/// What the seller paid at the register for the run's kept items.
struct RunCheckout: Equatable, Sendable {
    var totalCents: Int64
    /// How many items the haul had: the kept items unless the seller changed it.
    var itemCount: Int
    /// The scans kept on this iPhone, in the order kept.
    var keptScanIDs: [String]
    var place: String?
    /// The trip's date on this iPhone ("2026-10-31").
    var purchaseDate: String
    var miles: Int?
}

/// One scan as the app sends it: the item shot (and a tag close-up) as small JPEGs, what the
/// phone read on the tag, and the seller's note.
struct ScanRequest: Equatable, Sendable {
    var runID: String
    var itemJPEG: Data
    var tagJPEG: Data?
    var tagText: [String]
    var note: String?
    var replacesScanID: String?
}
