import APIClient
import Foundation
import ListoraAPI

/// The actions on an operation itself (Retry a failed one, Try now a waiting one), and deleting an
/// item.
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
}
