import APIClient
import Foundation
import ListoraAPI
@testable import TasksFeature

/// Offers as the server sends them, decoded from the contract's JSON.
enum OfferFixtures {
    static let offerID = "0199f0b4-0000-7000-8000-0000000000a1"

    static func offer(
        status: String = "pending",
        amountCents: Int = 3000,
        actions: [String] = ["accept", "decline", "counter"],
        response: [String: Any]? = nil,
    ) -> Offer {
        var object: [String: Any] = [
            "id": offerID,
            "marketplace": "depop",
            "status": status,
            "amount": money(amountCents),
            "listPrice": money(4000),
            "listingTitle": "Wool scarf",
            "buyerName": "scarffan",
            "expiresAt": Fixtures.created.addingTimeInterval(3600).ISO8601Format(),
            "url": "https://www.depop.com/sellinghub/offers/offer-1/",
            "actions": actions,
            "acceptNote": "Accepting lets the buyer buy it at this price; it sells once they check out.",
            "accept": ["price": money(amountCents), "fees": money(330), "net": money(amountCents - 330)],
            "counterRange": ["above": money(amountCents), "below": money(4000)],
            "firstSeenAt": Fixtures.created.ISO8601Format(),
            "lastSeenAt": Fixtures.created.ISO8601Format(),
        ]
        if let response {
            object["response"] = response
        }
        return decode(object)
    }

    static func response(action: String = "accept", status: String, statusText: String) -> [String: Any] {
        [
            "id": "0199f0b4-0000-7000-8000-0000000000a9",
            "action": action,
            "status": status,
            "statusText": statusText,
            "offerAmount": money(3000),
            "net": money(2670),
            "createdAt": Fixtures.created.ISO8601Format(),
        ]
    }

    static func money(_ cents: Int) -> [String: Any] {
        ["amountCents": cents, "currency": "USD"]
    }

    static func decode<T: Decodable>(_ object: [String: Any]) -> T {
        let data = try! JSONSerialization.data(withJSONObject: object) // swiftlint:disable:this force_try
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try! decoder.decode(T.self, from: data) // swiftlint:disable:this force_try
    }
}

/// An ``OffersService`` that answers from a script and records every call.
actor FakeOffersService: OffersService {
    struct Answer: Equatable {
        let action: OfferAction
        let offerAmountCents: Int64
        let counterCents: Int64?
        let key: String
    }

    private(set) var answers: [Answer] = []
    private(set) var checkRequests = 0
    /// What `answer` throws, in order; an empty script answers queued.
    var answerFailures: [APIFailure?] = []
    /// What `offer` returns, in order; the last one repeats.
    var reads: [Offer] = []
    var checks: [OfferCheck] = []

    func failAnswers(_ failures: [APIFailure?]) {
        answerFailures = failures
    }

    func setReads(_ offers: [Offer]) {
        reads = offers
    }

    func setChecks(_ checks: [OfferCheck]) {
        self.checks = checks
    }

    func offer(id _: String) async throws(APIFailure) -> Offer {
        guard let next = reads.first else {
            throw APIFailure(statusCode: 404, code: "not_found", message: "Offer was not found.", retryable: false)
        }
        if reads.count > 1 {
            reads.removeFirst()
        }
        return next
    }

    func quote(offerID _: String, priceCents: Int64) async throws(APIFailure) -> OfferQuote {
        OfferFixtures.decode([
            "price": OfferFixtures.money(Int(priceCents)),
            "fees": OfferFixtures.money(Int(priceCents) / 10),
            "net": OfferFixtures.money(Int(priceCents) - Int(priceCents) / 10),
        ])
    }

    func answer(
        offerID _: String,
        action: OfferAction,
        offerAmountCents: Int64,
        counterCents: Int64?,
        idempotencyKey: String,
    ) async throws(APIFailure) -> OfferResponse {
        answers.append(Answer(
            action: action, offerAmountCents: offerAmountCents, counterCents: counterCents, key: idempotencyKey,
        ))
        if !answerFailures.isEmpty, let failure = answerFailures.removeFirst() {
            throw failure
        }
        return OfferFixtures.decode(OfferFixtures.response(
            action: action.rawValue, status: "queued", statusText: "Accepting on your iPhone...",
        ))
    }

    func requestChecks(idempotencyKey _: String) async throws(APIFailure) -> [OfferCheck] {
        checkRequests += 1
        return checks
    }
}

/// Counts the times a model asked this phone to run its waiting work.
@MainActor
final class PhoneWorkCounter {
    private(set) var runs = 0

    func run() {
        runs += 1
    }
}
