import APIClient
import Foundation
import ListoraAPI

/// The actions on an operation itself (Retry a failed one, Try now a waiting one), waiting for a
/// change to an item's operations, and deleting an item.
extension APIInventoryService {
    func deleteItem(id: String, leavingListings: Bool) async throws(APIFailure) {
        let output = try await call {
            try await client.deleteItem(
                path: .init(itemId: id),
                query: .init(leaveListings: leavingListings ? true : nil),
            )
        }
        switch output {
        case .noContent: return
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func retry(operationID: String, idempotencyKey: String) async throws(APIFailure) -> Operation {
        let output = try await call {
            try await client.retryOperation(
                path: .init(operationId: operationID),
                headers: .init(idempotencyKey: idempotencyKey),
            )
        }
        switch output {
        case let .accepted(response):
            let operation = try body { try response.body.json }
            await queued()
            return operation
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func tryNow(operationID: String, idempotencyKey: String) async throws(APIFailure) -> Operation {
        let output = try await call {
            try await client.tryOperationNow(
                path: .init(operationId: operationID),
                headers: .init(idempotencyKey: idempotencyKey),
            )
        }
        switch output {
        case let .ok(response):
            let operation = try body { try response.body.json }
            // A step that runs on this phone runs now too.
            await queued()
            return operation
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func waitForChange(itemID: String, after: String?, waitSeconds: Int) async throws(APIFailure) -> ItemChangeWait {
        let output = try await call {
            try await client.waitForItemChange(
                path: .init(itemId: itemID),
                query: .init(after: after, waitSeconds: Int32(max(1, min(20, waitSeconds)))),
            )
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }
}
