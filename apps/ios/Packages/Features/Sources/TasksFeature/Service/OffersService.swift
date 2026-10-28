import APIClient
import Foundation
import ListoraAPI

typealias Offer = Components.Schemas.Offer
typealias OfferResponse = Components.Schemas.OfferResponse
typealias OfferQuote = Components.Schemas.OfferQuote
typealias OfferCheck = Components.Schemas.OfferCheck
typealias OfferAction = Components.Schemas.KnownOfferAction

/// The offers' calls (docs/features/offers.md), returning the contract's types and throwing
/// ``APIFailure`` for every other answer. A protocol so the models' tests run against a fake.
/// An answer is only ever sent for the seller's confirmed tap, and the server shows it as done
/// only once a read of the offer on the marketplace shows it.
protocol OffersService: Sendable {
    func offer(id: String) async throws(APIFailure) -> Offer
    /// What a price gives the seller after the marketplace's fees (for a counteroffer).
    func quote(offerID: String, priceCents: Int64) async throws(APIFailure) -> OfferQuote
    /// The seller's confirmed answer, queued for their iPhone.
    func answer(
        offerID: String,
        action: OfferAction,
        offerAmountCents: Int64,
        counterCents: Int64?,
        idempotencyKey: String,
    ) async throws(APIFailure) -> OfferResponse
    /// Asks the iPhone to read the offers (at most every 10 minutes per marketplace), and says
    /// when each marketplace's offers were last read.
    func requestChecks(idempotencyKey: String) async throws(APIFailure) -> [OfferCheck]
}

/// ``OffersService`` over the generated client.
struct APIOffersService: OffersService {
    let client: Client

    func offer(id: String) async throws(APIFailure) -> Offer {
        switch try await call({ try await client.getOffer(path: .init(offerId: id)) }) {
        case let .ok(response): try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func quote(offerID: String, priceCents: Int64) async throws(APIFailure) -> OfferQuote {
        let output = try await call {
            try await client.getOfferQuote(path: .init(offerId: offerID), query: .init(priceCents: priceCents))
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func answer(
        offerID: String,
        action: OfferAction,
        offerAmountCents: Int64,
        counterCents: Int64?,
        idempotencyKey: String,
    ) async throws(APIFailure) -> OfferResponse {
        let output = try await call {
            try await client.answerOffer(
                path: .init(offerId: offerID),
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(.init(
                    action: action,
                    offerAmount: .init(amountCents: offerAmountCents, currency: .usd),
                    counter: counterCents.map { .init(amountCents: $0, currency: .usd) },
                )),
            )
        }
        switch output {
        case let .accepted(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func requestChecks(idempotencyKey: String) async throws(APIFailure) -> [OfferCheck] {
        let output = try await call {
            try await client.requestOfferChecks(headers: .init(idempotencyKey: idempotencyKey))
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }.data
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

/// No offers: the tests and previews of screens that never show one.
struct NoOffers: OffersService {
    func offer(id _: String) async throws(APIFailure) -> Offer {
        throw APIFailure(statusCode: 404, code: "not_found", message: "No such offer.", retryable: false)
    }

    func quote(offerID _: String, priceCents _: Int64) async throws(APIFailure) -> OfferQuote {
        throw APIFailure(statusCode: 404, code: "not_found", message: "No such offer.", retryable: false)
    }

    func answer(
        offerID _: String,
        action _: OfferAction,
        offerAmountCents _: Int64,
        counterCents _: Int64?,
        idempotencyKey _: String,
    ) async throws(APIFailure) -> OfferResponse {
        throw APIFailure(statusCode: 404, code: "not_found", message: "No such offer.", retryable: false)
    }

    func requestChecks(idempotencyKey _: String) async throws(APIFailure) -> [OfferCheck] {
        []
    }
}
