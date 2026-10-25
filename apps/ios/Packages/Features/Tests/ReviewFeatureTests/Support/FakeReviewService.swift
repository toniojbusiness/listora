import APIClient
import Foundation
import ListoraAPI
@testable import ReviewFeature

/// A scripted server for the review flow. Each list of answers is used in order and its last
/// answer repeats; every request is recorded.
actor FakeReviewService: ReviewService {
    enum Call: Equatable {
        case item
        case startAnalysis(key: String)
        case analysis(String)
        case escalate(String)
        case apply(String, version: Int64)
        case replace(version: Int64)
        case pricing
        case usage
    }

    private(set) var calls: [Call] = []
    private(set) var replacements: [Schemas.ItemReplace] = []

    var items: [Result<Schemas.Item, APIFailure>] = [.success(Fixtures.item())]
    var starts: [Result<Schemas.Analysis, APIFailure>] = [.success(Fixtures.analysis(status: .queued))]
    var analyses: [String: [Result<Schemas.Analysis, APIFailure>]] = [:]
    var escalations: [Result<Schemas.Analysis, APIFailure>] = []
    var applies: [Result<Schemas.Item, APIFailure>] = [.success(Fixtures.appliedItem())]
    /// Nil answers a replace with the item it describes (version + 1).
    var replaceAnswers: [Result<Schemas.Item, APIFailure>]?
    var pricingAnswers: [Result<Schemas.PricingSuggestion, APIFailure>] = [.success(Fixtures.pricing())]
    var usageAnswers: [Result<Schemas.Usage, APIFailure>] = [.success(Fixtures.usage(premiumUsed: 2, limit: 10))]
    private var latestItem: Schemas.Item?

    func setItems(_ answers: [Result<Schemas.Item, APIFailure>]) {
        items = answers
    }

    func setStarts(_ answers: [Result<Schemas.Analysis, APIFailure>]) {
        starts = answers
    }

    func setAnalyses(_ id: String, _ answers: [Result<Schemas.Analysis, APIFailure>]) {
        analyses[id] = answers
    }

    func setEscalations(_ answers: [Result<Schemas.Analysis, APIFailure>]) {
        escalations = answers
    }

    func setApplies(_ answers: [Result<Schemas.Item, APIFailure>]) {
        applies = answers
    }

    func setReplaceAnswers(_ answers: [Result<Schemas.Item, APIFailure>]?) {
        replaceAnswers = answers
    }

    func setPricing(_ answers: [Result<Schemas.PricingSuggestion, APIFailure>]) {
        pricingAnswers = answers
    }

    func setUsage(_ answers: [Result<Schemas.Usage, APIFailure>]) {
        usageAnswers = answers
    }

    func item(id _: String) async throws(APIFailure) -> Schemas.Item {
        calls.append(.item)
        let item = try next(&items)
        latestItem = item
        return item
    }

    func startAnalysis(itemID _: String, idempotencyKey: String) async throws(APIFailure) -> Schemas.Analysis {
        calls.append(.startAnalysis(key: idempotencyKey))
        return try next(&starts)
    }

    func analysis(id: String) async throws(APIFailure) -> Schemas.Analysis {
        calls.append(.analysis(id))
        var answers = analyses[id] ?? []
        defer { analyses[id] = answers }
        return try next(&answers)
    }

    func escalate(analysisID: String, idempotencyKey _: String) async throws(APIFailure) -> Schemas.Analysis {
        calls.append(.escalate(analysisID))
        return try next(&escalations)
    }

    func apply(analysisID: String, expectedVersion: Int64, idempotencyKey _: String) async throws(APIFailure)
        -> Schemas.Item
    {
        calls.append(.apply(analysisID, version: expectedVersion))
        let item = try next(&applies)
        latestItem = item
        return item
    }

    func replace(itemID _: String, with replace: Schemas.ItemReplace) async throws(APIFailure) -> Schemas.Item {
        calls.append(.replace(version: replace.expectedVersion))
        replacements.append(replace)
        if var answers = replaceAnswers {
            defer { replaceAnswers = answers }
            let item = try next(&answers)
            latestItem = item
            return item
        }
        var item = latestItem ?? Fixtures.item()
        item.version = replace.expectedVersion + 1
        item.details = replace.details
        if let status = replace.status {
            item.status = .init(value1: .init(rawValue: status.rawValue), value2: status.rawValue)
        }
        latestItem = item
        return item
    }

    func pricing(itemID _: String) async throws(APIFailure) -> Schemas.PricingSuggestion {
        calls.append(.pricing)
        return try next(&pricingAnswers)
    }

    func usage() async throws(APIFailure) -> Schemas.Usage {
        calls.append(.usage)
        return try next(&usageAnswers)
    }

    private func next<Value>(_ answers: inout [Result<Value, APIFailure>]) throws(APIFailure) -> Value {
        guard let first = answers.first else {
            throw APIFailure(statusCode: 500, code: "unscripted", message: "Nothing scripted.", retryable: false)
        }
        if answers.count > 1 {
            answers.removeFirst()
        }
        return try first.get()
    }
}

extension APIFailure {
    static func server(_ status: Int, _ code: String, _ message: String, retryable: Bool = false) -> APIFailure {
        APIFailure(statusCode: status, code: code, message: message, retryable: retryable)
    }
}
