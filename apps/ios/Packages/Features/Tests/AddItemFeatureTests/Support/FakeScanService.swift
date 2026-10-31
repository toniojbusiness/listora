import APIClient
import Core
import Foundation
import ListoraAPI
import Synchronization
@testable import AddItemFeature

// Invented scans and sales; no real shop's data.

/// A scan's answer as the server would send it.
func itemScanJSON(
    id: String = UUID().uuidString.lowercased(),
    call: String = "buy",
    confidence: String = "medium",
    basis: String = "own_history",
    brand: String? = "Lululemon",
    identityConfidence: Double = 0.9,
) -> [String: Any] {
    var identity: [String: Any] = [
        "item": "black high-rise leggings",
        "category": "clothing/bottoms/leggings",
        "sizeLabel": "6",
        "condition": "pre_owned_good",
        "confidence": identityConfidence,
    ]
    identity["brand"] = brand
    let label = ["buy": "Buy", "your_call": "Your call", "skip": "Skip"][call] ?? call
    return [
        "id": id,
        "runId": "0193a000-0000-7000-8000-000000000002",
        "createdAt": "2026-10-31T00:00:00Z",
        "identity": identity,
        "aiEstimate": [
            "label": "AI estimate - not based on sold listings",
            "low": usd(2400), "mid": usd(3200), "high": usd(4000),
        ],
        "flags": ["visibleDamage": false, "lotOrBundle": false, "counterfeitProne": true],
        "ownSales": [[
            "marketplace": "depop",
            "label": "Your sales of similar Lululemon items on Depop (last 365 days)",
            "soldCount": 3, "low": usd(2500), "median": usd(2800), "high": usd(2900), "displayOnly": false,
        ]],
        "call": [
            "call": call, "label": label, "confidence": confidence, "basis": basis,
            "basedOn": "Your 3 sales like it", "low": usd(2500), "high": usd(2900), "signals": [Any](),
            "conservativePayout": usd(2210), "optimisticPayout": usd(2570), "payoutMarketplace": "depop",
            "worthListing": usd(800),
        ],
        "searchWords": "lululemon align leggings",
        "researchLinks": [["label": "Search Depop", "url": "https://www.depop.com/search/?q=lululemon"]],
        "decision": "undecided",
    ]
}

/// The scan's answer with a Depop comparison: one for the phone to read (`checking`), or read.
func comparedScanJSON(id: String, status: String, readID: String = "read-1") -> [String: Any] {
    var scan = itemScanJSON(id: id)
    var row: [String: Any] = ["marketplace": "depop", "status": status]
    switch status {
    case "checking":
        row["label"] = "Checking Depop..."
        let input: [String: Any] = ["version": 1, "marketplace": "depop", "query": ["words": "levis 501 jeans"]]
        row["read"] = ["id": readID, "input": input]
    case "read":
        row["label"] = "Depop: asking $15-$25, 6 like it for sale"
        row["asking"] = [
            "count": 6, "low": usd(1500), "median": usd(2000), "high": usd(2500),
            "label": "Asking prices - not sold listings",
        ]
        row["supply"] = 40
        row["demand"] = [
            "demand": "strong", "label": "Sells for you, little competition",
            "basedOn": "Your 4 sales like it in the last 90 days; 40 for sale on Depop now",
        ]
        var call = scan["call"] as? [String: Any] ?? [:]
        call["signals"] = [[
            "kind": "asking", "label": "Asking $15-$25 on Depop",
            "basedOn": "Asking prices - not sold listings: 6 like it for sale on Depop",
        ]]
        scan["call"] = call
    default:
        row["label"] = "Depop prices paused today"
    }
    scan["comparisons"] = [row]
    return scan
}

/// The scan's answer with eBay's comparison read: what close matches sold for, the call resting
/// on them, and eBay's sold pace.
func ebaySoldScanJSON(id: String) -> [String: Any] {
    var scan = itemScanJSON(id: id, call: "buy", basis: "market_sold")
    let pace = "Sold listings on eBay: 410 in the last 90 days; 320 for sale now"
    scan["comparisons"] = [[
        "marketplace": "ebay", "status": "read",
        "label": "eBay: sold $18-$30, 9 like it in the last 14 days",
        "asking": [
            "count": 4, "low": usd(2500), "median": usd(2900), "high": usd(3500),
            "label": "Asking prices - not sold listings",
        ],
        "sold": [
            "count": 9, "low": usd(1800), "median": usd(2400), "high": usd(3000), "windowDays": 14,
            "label": "Sold listings on eBay",
        ],
        "supply": 320,
        "demand": ["demand": "strong", "label": "Sells fast on eBay", "basedOn": pace],
    ]]
    var call = scan["call"] as? [String: Any] ?? [:]
    call["basedOn"] = "Sold listings on eBay: 9 like it in the last 14 days"
    call["signals"] = [["kind": "demand", "label": "Sells fast on eBay", "basedOn": pace]]
    scan["call"] = call
    return scan
}

/// The scan's answer once the web research came in.
func researchedScanJSON(id: String) -> [String: Any] {
    var scan = itemScanJSON(id: id, call: "buy", basis: "web_info")
    var call = scan["call"] as? [String: Any] ?? [:]
    call["basedOn"] = "Web info - not sold listings: poshmark.com, ebay.com"
    call["signals"] = [[
        "kind": "retail", "label": "Retail $60-$98 across 3 models",
        "basedOn": "Web info - not sold listings: levi.com",
    ]]
    scan["call"] = call
    scan["research"] = [
        "status": "found", "label": "Web info - not sold listings", "reputation": "strong", "cached": false,
        "summary": "Levi's lists them at $60-$98; used ones ask $30-$50 on Poshmark and eBay.",
        "retail": [
            "low": usd(5950), "high": usd(9800), "models": ["501", "517", "527"],
            "sources": [["site": "levi.com", "url": "https://www.levi.com/x"]],
        ],
        "resale": [
            "low": usd(3000), "high": usd(5000),
            "sources": [
                ["site": "poshmark.com", "url": "https://poshmark.com/x"],
                ["site": "ebay.com", "url": "https://www.ebay.com/x"],
            ],
        ],
    ]
    return scan
}

private func usd(_ cents: Int) -> [String: Any] {
    ["amountCents": cents, "currency": "USD"]
}

func decodeScan(_ object: [String: Any]) throws -> ItemScan {
    try decodeScan(JSONSerialization.data(withJSONObject: object))
}

func decodeScan(_ data: Data) throws -> ItemScan {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(ItemScan.self, from: data)
}

/// The scan's calls, scripted: each read answers the next scripted result.
final class FakeScanService: ScanService {
    struct Calls {
        var runs = 0
        /// The place each run was started at.
        var places: [String?] = []
        var ended: [String] = []
        var scans: [ScanRequest] = []
        /// Each read's `Idempotency-Key`, in order.
        var scanKeys: [String] = []
        var kits = 0
        var checkouts: [Checkout] = []
    }

    struct Checkout {
        var runID: String
        var checkout: RunCheckout
        var key: String
    }

    /// Scripted answers, as the JSON the server would send.
    private let state = Mutex<(calls: Calls, answers: [Result<Data, APIFailure>])>((Calls(), []))
    /// Reads wait until this is opened, so a test can look at a card still reading.
    let gate = ScanGate()

    var calls: Calls {
        state.withLock { $0.calls }
    }

    func answer(scanJSON object: [String: Any]) {
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
        state.withLock { $0.answers.append(.success(data)) }
    }

    func answer(failure: APIFailure) {
        state.withLock { $0.answers.append(.failure(failure)) }
    }

    func createSourcingRun(place: String?, idempotencyKey _: String) async throws(APIFailure) -> String {
        state.withLock { state in
            state.calls.runs += 1
            state.calls.places.append(place)
        }
        return "run-1"
    }

    /// Scripted checkout answers; by default a checked-out summary.
    private let checkoutAnswers = Mutex<[Result<Data, APIFailure>]>([])

    func answerCheckout(failure: APIFailure) {
        checkoutAnswers.withLock { $0.append(.failure(failure)) }
    }

    func checkoutSourcingRun(
        runID: String,
        _ checkout: RunCheckout,
        idempotencyKey: String,
    ) async throws(APIFailure) -> SourcingRunSummary {
        state.withLock { $0.calls.checkouts.append(Checkout(runID: runID, checkout: checkout, key: idempotencyKey)) }
        let next = checkoutAnswers.withLock { $0.isEmpty ? nil : $0.removeFirst() }
        switch next ?? .success((try? JSONSerialization.data(withJSONObject: runSummaryJSON())) ?? Data()) {
        case let .success(data):
            do {
                return try decodeRunSummary(data)
            } catch {
                throw APIFailure(error)
            }
        case let .failure(failure):
            throw failure
        }
    }

    func createScan(_ request: ScanRequest, idempotencyKey: String) async throws(APIFailure) -> ItemScan {
        await gate.wait()
        let next = state.withLock { state -> Result<Data, APIFailure>? in
            state.calls.scans.append(request)
            state.calls.scanKeys.append(idempotencyKey)
            return state.answers.isEmpty ? nil : state.answers.removeFirst()
        }
        switch next ?? .success(Self.defaultAnswer()) {
        case let .success(data):
            do {
                return try decodeScan(data)
            } catch {
                throw APIFailure(error)
            }
        case let .failure(failure):
            throw failure
        }
    }

    private static func defaultAnswer() -> Data {
        (try? JSONSerialization.data(withJSONObject: itemScanJSON())) ?? Data()
    }

    /// The research's answers, scripted like the reads'; by default the read again with web info.
    private let research = Mutex<(asked: [String], answers: [Result<Data, APIFailure>])>(([], []))

    var researched: [String] {
        research.withLock { $0.asked }
    }

    func answerResearch(_ data: Data) {
        research.withLock { $0.answers.append(.success(data)) }
    }

    func researchScan(scanID: String, idempotencyKey _: String) async throws(APIFailure) -> ItemScan {
        let next = research.withLock { state -> Result<Data, APIFailure>? in
            state.asked.append(scanID)
            return state.answers.isEmpty ? nil : state.answers.removeFirst()
        }
        switch next ?? .failure(APIFailure(
            statusCode: 503,
            code: "service_unavailable",
            message: "No web.",
            retryable: true,
        )) {
        case let .success(data):
            do {
                return try decodeScan(data)
            } catch {
                throw APIFailure(error)
            }
        case let .failure(failure):
            throw failure
        }
    }

    func endSourcingRun(runID: String, idempotencyKey _: String) async throws(APIFailure) {
        state.withLock { $0.calls.ended.append(runID) }
    }

    /// The kit `sourcingKit()` answers; nil answers as with no signal.
    private let kit = Mutex<SourcingKit?>(nil)

    func answer(kit: SourcingKit?) {
        self.kit.withLock { $0 = kit }
    }

    func sourcingKit() async throws(APIFailure) -> SourcingKit {
        state.withLock { $0.calls.kits += 1 }
        guard let kit = kit.withLock({ $0 }) else { throw APIFailure.networkUnavailable }
        return kit
    }

    /// One comparison answer the phone sent.
    struct SentComparison {
        let scanID: String
        let readID: String
        let data: Data

        var answer: [String: Any] {
            (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        }
    }

    /// The comparison answers the phone sent, and the scripted replies.
    private let compared = Mutex<(sent: [SentComparison], replies: [Result<Data, APIFailure>])>(([], []))

    var comparisonsSent: [SentComparison] {
        compared.withLock(\.sent)
    }

    func answerComparison(_ object: [String: Any]) {
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
        compared.withLock { $0.replies.append(.success(data)) }
    }

    func answerComparison(failure: APIFailure) {
        compared.withLock { $0.replies.append(.failure(failure)) }
    }

    func saveScanComparison(scanID: String, comparisonID: String, answer: Data) async throws(APIFailure) -> ItemScan {
        let next = compared.withLock { state -> Result<Data, APIFailure>? in
            state.sent.append(SentComparison(scanID: scanID, readID: comparisonID, data: answer))
            return state.replies.isEmpty ? nil : state.replies.removeFirst()
        }
        switch next ?? .failure(.networkUnavailable) {
        case let .success(data):
            do {
                return try decodeScan(data)
            } catch {
                throw APIFailure(error)
            }
        case let .failure(failure):
            throw failure
        }
    }
}

/// The comparison lane, scripted: what each read answers, and what was asked of it.
@MainActor
final class FakeComparisons: MarketComparisons {
    var warmed: [[String]] = []
    var cooled = 0
    var reads: [(input: [String: Any], marketplace: String)] = []
    /// The runtime's answer to every read; nil as an app that can't read.
    var answer: [String: Any]? = [
        "outcome": "read", "ms": 900, "forSaleTotal": 40,
        "stats": [
            "level": "model",
            "forSale": ["count": 6, "lowCents": 1500, "medianCents": 2000, "highCents": 2500],
            "read": ["sold": 0, "forSale": 24],
        ],
    ]

    func warmUp(_ marketplaces: [String]) {
        warmed.append(marketplaces)
    }

    func compare(_ input: Data, marketplace: String) async -> Data? {
        reads.append(((try? JSONSerialization.jsonObject(with: input)) as? [String: Any] ?? [:], marketplace))
        return answer.flatMap { try? JSONSerialization.data(withJSONObject: $0) }
    }

    func coolDown() {
        cooled += 1
    }
}

/// Opens once; until then every waiter waits.
actor ScanGate {
    private var isOpen = true
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func close() {
        isOpen = false
    }

    func open() {
        isOpen = true
        for waiter in waiters {
            waiter.resume()
        }
        waiters = []
    }

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { waiters.append($0) }
    }
}
