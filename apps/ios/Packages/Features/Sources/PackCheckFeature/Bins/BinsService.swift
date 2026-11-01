import APIClient
import Foundation
import ListoraAPI

typealias Bin = Components.Schemas.StorageLocation
typealias BinDetail = Components.Schemas.StorageLocationDetail
typealias BinItem = Components.Schemas.StorageLocationItem

/// The account's bins and the code to offer for the next one.
struct BinList: Equatable, Sendable {
    var bins: [Bin]
    var nextCode: String
}

/// Storage bins' calls (docs/features/storage-bins.md), returning the contract's types and
/// throwing ``APIFailure`` for every other answer. A protocol so the models' tests run against a
/// fake.
protocol BinsService: Sendable {
    func bins() async throws(APIFailure) -> BinList
    func bin(id: String) async throws(APIFailure) -> BinDetail
    func create(code: String, label: String?, idempotencyKey: String) async throws(APIFailure) -> Bin
    func rename(id: String, code: String, label: String?) async throws(APIFailure) -> Bin
    func delete(id: String) async throws(APIFailure)
    /// Puts the items in the bin; each leaves the one it was in.
    func put(itemIDs: [String], inBin id: String, idempotencyKey: String) async throws(APIFailure) -> BinDetail
    func takeOut(itemID: String, ofBin id: String) async throws(APIFailure) -> BinDetail
}

/// ``BinsService`` over the generated client.
struct APIBinsService: BinsService {
    let client: Client

    func bins() async throws(APIFailure) -> BinList {
        switch try await call({ try await client.listStorageLocations() }) {
        case let .ok(response):
            let page = try body { try response.body.json }
            return BinList(bins: page.data, nextCode: page.nextCode)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func bin(id: String) async throws(APIFailure) -> BinDetail {
        switch try await call({ try await client.getStorageLocation(path: .init(storageLocationId: id)) }) {
        case let .ok(response): try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func create(code: String, label: String?, idempotencyKey: String) async throws(APIFailure) -> Bin {
        let output = try await call {
            try await client.createStorageLocation(
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(.init(code: code, label: label)),
            )
        }
        switch output {
        case let .created(response): return try body { try response.body.json }
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func rename(id: String, code: String, label: String?) async throws(APIFailure) -> Bin {
        let output = try await call {
            try await client.replaceStorageLocation(
                path: .init(storageLocationId: id),
                body: .json(.init(code: code, label: label)),
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

    func delete(id: String) async throws(APIFailure) {
        switch try await call({ try await client.deleteStorageLocation(path: .init(storageLocationId: id)) }) {
        case .noContent: return
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func put(itemIDs: [String], inBin id: String, idempotencyKey: String) async throws(APIFailure) -> BinDetail {
        let output = try await call {
            try await client.addStorageLocationItems(
                path: .init(storageLocationId: id),
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(.init(itemIds: itemIDs)),
            )
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func takeOut(itemID: String, ofBin id: String) async throws(APIFailure) -> BinDetail {
        let output = try await call {
            try await client.removeStorageLocationItem(path: .init(storageLocationId: id, itemId: itemID))
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

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

/// Bins for an environment built without them (previews and tests of other screens): every
/// call fails as if offline.
struct UnavailableBins: BinsService {
    func bins() async throws(APIFailure) -> BinList {
        throw .networkUnavailable
    }

    func bin(id _: String) async throws(APIFailure) -> BinDetail {
        throw .networkUnavailable
    }

    func create(code _: String, label _: String?, idempotencyKey _: String) async throws(APIFailure) -> Bin {
        throw .networkUnavailable
    }

    func rename(id _: String, code _: String, label _: String?) async throws(APIFailure) -> Bin {
        throw .networkUnavailable
    }

    func delete(id _: String) async throws(APIFailure) {
        throw .networkUnavailable
    }

    func put(itemIDs _: [String], inBin _: String, idempotencyKey _: String) async throws(APIFailure) -> BinDetail {
        throw .networkUnavailable
    }

    func takeOut(itemID _: String, ofBin _: String) async throws(APIFailure) -> BinDetail {
        throw .networkUnavailable
    }
}
