import APIClient
import Foundation
import ListoraAPI

typealias Sale = Components.Schemas.Sale
typealias SaleItem = Components.Schemas.SaleItem
typealias Money = Components.Schemas.Money
typealias KnownMarketplace = Components.Schemas.KnownMarketplace
typealias ItemSummary = Components.Schemas.ItemSummary

/// One page of the sales feed.
struct SalePage: Equatable, Sendable {
    var sales: [Sale]
    var nextCursor: String?
}

/// A sale the seller records by hand ("Mark as sold").
struct NewSale: Equatable, Sendable {
    struct Line: Equatable, Sendable {
        var itemID: String
        var priceCents: Int64
    }

    var marketplace: KnownMarketplace
    var lines: [Line]
    var shippingChargedCents: Int64
    var soldAt: Date
    var orderNumber: String?
}

/// A step in a sale's lifecycle.
enum SaleChange: Equatable, Sendable {
    case confirm
    case markShipped(labelCostCents: Int64?)
    case cancel
    case recordReturn
}

/// The calls of the sales screens, returning the contract's types and throwing ``APIFailure``
/// for every other answer. A protocol so the models' tests run against a fake. Recording a sale
/// starts the server's auto-delist, and a relist goes through its operation engine: the screens
/// show what the server reports and never decide an outcome themselves.
protocol SalesService: Sendable {
    func sales(cursor: String?) async throws(APIFailure) -> SalePage
    func sale(id: String) async throws(APIFailure) -> Sale
    /// Items to add to a bundle: the seller's unsold items matching `search`.
    func sellableItems(search: String) async throws(APIFailure) -> [ItemSummary]
    func record(_ sale: NewSale, idempotencyKey: String) async throws(APIFailure) -> Sale
    func change(saleID: String, _ change: SaleChange, idempotencyKey: String) async throws(APIFailure) -> Sale
    /// The seller's answer to "Relist it?": per item, the listings to relist (none: don't).
    func decideRelist(
        saleID: String,
        choices: [String: [String]],
        idempotencyKey: String,
    ) async throws(APIFailure) -> Sale
}

/// ``SalesService`` over the generated client.
struct APISalesService: SalesService {
    let client: Client
    /// Runs once the server queued marketplace changes (a sale's delists, relists): the phone
    /// takes at once the ones that run on it (docs/features/phone-execution.md).
    var queued: @MainActor @Sendable () -> Void = {}

    func sales(cursor: String?) async throws(APIFailure) -> SalePage {
        switch try await call({ try await client.listSales(query: .init(cursor: cursor, limit: 50)) }) {
        case let .ok(response):
            let page = try body { try response.body.json }
            return SalePage(sales: page.data, nextCursor: page.nextCursor)
        case let .badRequest(response): throw APIFailure(statusCode: 400, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func sale(id: String) async throws(APIFailure) -> Sale {
        switch try await call({ try await client.getSale(path: .init(saleId: id)) }) {
        case let .ok(response): try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func sellableItems(search: String) async throws(APIFailure) -> [ItemSummary] {
        let text = search.trimmingCharacters(in: .whitespacesAndNewlines)
        let output = try await call {
            try await client.listItems(query: .init(
                status: [.ready, .listed, .draft],
                q: text.isEmpty ? nil : String(text.prefix(200)),
                limit: 20,
            ))
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }.data
        case let .badRequest(response): throw APIFailure(statusCode: 400, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func record(_ sale: NewSale, idempotencyKey: String) async throws(APIFailure) -> Sale {
        let request = Components.Schemas.SaleCreate(
            marketplace: sale.marketplace,
            items: sale.lines.map { line in
                .init(itemId: line.itemID, salePrice: Money(amountCents: line.priceCents, currency: .usd))
            },
            shippingCharged: Money(amountCents: sale.shippingChargedCents, currency: .usd),
            soldAt: sale.soldAt,
            externalOrderId: sale.orderNumber,
        )
        let output = try await call {
            try await client.createSale(headers: .init(idempotencyKey: idempotencyKey), body: .json(request))
        }
        switch output {
        case let .created(response):
            let sale = try body { try response.body.json }
            await queued()
            return sale
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func change(saleID: String, _ change: SaleChange, idempotencyKey key: String) async throws(APIFailure) -> Sale {
        switch change {
        case .confirm: try await confirm(saleID: saleID, key: key)
        case let .markShipped(labelCostCents): try await ship(saleID: saleID, labelCostCents: labelCostCents, key: key)
        case .cancel: try await cancel(saleID: saleID, key: key)
        case .recordReturn: try await recordReturn(saleID: saleID, key: key)
        }
    }

    private func confirm(saleID: String, key: String) async throws(APIFailure) -> Sale {
        let output = try await call {
            try await client.confirmSale(path: .init(saleId: saleID), headers: .init(idempotencyKey: key))
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    private func ship(saleID: String, labelCostCents: Int64?, key: String) async throws(APIFailure) -> Sale {
        let shipment = Components.Schemas.SaleShipment(
            shippingCost: labelCostCents.map { Money(amountCents: $0, currency: .usd) },
        )
        let output = try await call {
            try await client.markSaleShipped(
                path: .init(saleId: saleID),
                headers: .init(idempotencyKey: key),
                body: .json(shipment),
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

    private func cancel(saleID: String, key: String) async throws(APIFailure) -> Sale {
        let output = try await call {
            try await client.cancelSale(path: .init(saleId: saleID), headers: .init(idempotencyKey: key))
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    private func recordReturn(saleID: String, key: String) async throws(APIFailure) -> Sale {
        let output = try await call {
            try await client.recordSaleReturn(path: .init(saleId: saleID), headers: .init(idempotencyKey: key))
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func decideRelist(
        saleID: String,
        choices: [String: [String]],
        idempotencyKey key: String,
    ) async throws(APIFailure) -> Sale {
        let request = Components.Schemas.SaleRelistChoice(
            items: choices.keys.sorted().map { itemID in
                .init(itemId: itemID, listingIds: choices[itemID] ?? [])
            },
        )
        let output = try await call {
            try await client.decideSaleRelist(
                path: .init(saleId: saleID),
                headers: .init(idempotencyKey: key),
                body: .json(request),
            )
        }
        switch output {
        case let .ok(response):
            let sale = try body { try response.body.json }
            await queued()
            return sale
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
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
