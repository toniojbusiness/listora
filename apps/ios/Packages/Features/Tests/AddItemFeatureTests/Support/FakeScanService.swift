import APIClient
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
        var ended: [String] = []
        var scans: [ScanRequest] = []
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

    func createSourcingRun(idempotencyKey _: String) async throws(APIFailure) -> String {
        state.withLock { $0.calls.runs += 1 }
        return "run-1"
    }

    func createScan(_ request: ScanRequest, idempotencyKey _: String) async throws(APIFailure) -> ItemScan {
        await gate.wait()
        let next = state.withLock { state -> Result<Data, APIFailure>? in
            state.calls.scans.append(request)
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
