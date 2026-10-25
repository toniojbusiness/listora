import APIClient
import Foundation
import ListoraAPI

typealias ItemBatch = Components.Schemas.ItemBatch
typealias ItemBatchItem = Components.Schemas.ItemBatchItem

/// The batch calls of the upload queue and the batch screen (docs/features/batch.md).
extension UploadAPI {
    /// Creates the server batch; returns its id.
    func createItemBatch(idempotencyKey: String) async throws(APIFailure) -> String {
        let output = try await call {
            try await client.createItemBatch(headers: .init(idempotencyKey: idempotencyKey))
        }
        switch output {
        case let .created(created):
            return try body { try created.body.json }.id
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    /// The batch's item at `position`: created now, or the one already there.
    func addItemBatchItem(
        batchID: String,
        position: Int,
        idempotencyKey: String,
    ) async throws(APIFailure) -> (id: String, sku: String) {
        let output = try await call {
            try await client.addItemBatchItem(
                path: .init(batchId: batchID),
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(.init(position: Int32(position))),
            )
        }
        let item: ItemBatchItem
        switch output {
        case let .created(created):
            item = try body { try created.body.json }
        case let .ok(existing):
            item = try body { try existing.body.json }
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .unprocessableContent(response):
            throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
        return (item.item.id, item.item.sku)
    }

    func submitItemBatchItem(
        batchID: String,
        itemID: String,
        photoCount: Int,
        idempotencyKey: String,
    ) async throws(APIFailure) {
        let output = try await call {
            try await client.submitItemBatchItem(
                path: .init(batchId: batchID, itemId: itemID),
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(.init(photoCount: Int32(photoCount))),
            )
        }
        switch output {
        case .accepted:
            return
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

    func replaceItemBatchInteraction(batchID: String, interaction: BatchInteraction) async throws(APIFailure) {
        let totals = { (totals: BatchInteraction.Totals) in
            Components.Schemas.InteractionTotals(
                activeMs: totals.activeMs,
                waitingMs: totals.waitingMs,
                taps: Int32(clamping: totals.taps),
            )
        }
        let replace = Components.Schemas.ItemBatchInteractionReplace(
            batch: totals(interaction.batch),
            items: interaction.items.map { .init(itemId: $0.serverItemID, interaction: totals($0.totals)) },
        )
        let output = try await call {
            try await client.replaceItemBatchInteraction(path: .init(batchId: batchID), body: .json(replace))
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

    /// The batch as the server has it: every item's state, in haul order.
    func itemBatch(id: String) async throws(APIFailure) -> ItemBatch {
        let output = try await call { try await client.getItemBatch(path: .init(batchId: id)) }
        switch output {
        case let .ok(response):
            return try body { try response.body.json }
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }
}
