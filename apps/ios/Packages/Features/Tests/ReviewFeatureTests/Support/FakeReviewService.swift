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
        case voice(String, key: String)
        case hauls
        case createHaul(key: String)
        case addHaulItems(haulID: String, itemIDs: [String])
        case removeHaulItem(haulID: String)
        case replaceHaul(haulID: String, count: Int32)
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
    var voiceAnswers: [Result<Schemas.VoiceCorrection, APIFailure>] = [.success(.init(changes: []))]
    /// The pre-fill reads and answers, kept apart from `calls` so the flow's order stays readable.
    private(set) var prefillReads: [Schemas.PrefillDetails] = []
    private(set) var prefillAnswers: [Schemas.PrefillAnswer] = []
    /// Nil answers no marketplace (none connected); otherwise the pre-fill each read gets.
    var prefillResponses: [Result<Schemas.ItemMarketplacePrefill, APIFailure>]?
    var prefillAnswerResponses: [Result<Schemas.ItemMarketplacePrefill, APIFailure>] = []
    private var latestItem: Schemas.Item?
    /// The seller's hauls, newest first, as `hauls()` answers them.
    var haulList: [Schemas.Haul] = []
    /// Nil answers a create with the haul it describes.
    var createHaulAnswers: [Result<Schemas.Haul, APIFailure>]?
    private(set) var haulCreates: [Schemas.HaulCreate] = []
    /// The item as the haul changes left it (its share as its cost), which `item(id:)` then
    /// answers like the server would.
    private var haulItem: Schemas.Item?

    func setHauls(_ hauls: [Schemas.Haul]) {
        haulList = hauls
    }

    func setCreateHaulAnswers(_ answers: [Result<Schemas.Haul, APIFailure>]?) {
        createHaulAnswers = answers
    }

    func setPrefill(_ answers: [Result<Schemas.ItemMarketplacePrefill, APIFailure>]?) {
        prefillResponses = answers
    }

    func setPrefillAnswers(_ answers: [Result<Schemas.ItemMarketplacePrefill, APIFailure>]) {
        prefillAnswerResponses = answers
    }

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

    func setVoiceAnswers(_ answers: [Result<Schemas.VoiceCorrection, APIFailure>]) {
        voiceAnswers = answers
    }

    func item(id _: String) async throws(APIFailure) -> Schemas.Item {
        calls.append(.item)
        if let haulItem {
            latestItem = haulItem
            return haulItem
        }
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
        if haulItem != nil {
            haulItem = item
        }
        return item
    }

    func pricing(itemID _: String) async throws(APIFailure) -> Schemas.PricingSuggestion {
        calls.append(.pricing)
        return try next(&pricingAnswers)
    }

    func hauls() async throws(APIFailure) -> [Schemas.Haul] {
        calls.append(.hauls)
        return haulList
    }

    func createHaul(_ haul: Schemas.HaulCreate, idempotencyKey: String) async throws(APIFailure) -> Schemas.Haul {
        calls.append(.createHaul(key: idempotencyKey))
        haulCreates.append(haul)
        let created: Schemas.Haul
        if var answers = createHaulAnswers {
            defer { createHaulAnswers = answers }
            created = try next(&answers)
        } else {
            created = Fixtures.haul(
                id: "haul-\(haulCreates.count)",
                totalCents: haul.total.amountCents,
                count: max(haul.itemCount, Int32(haul.itemIds?.count ?? 0)),
                added: Int32(haul.itemIds?.count ?? 0),
                source: haul.purchaseSource,
            )
        }
        haulList.insert(created, at: 0)
        joined(created, place: 0)
        return created
    }

    func addHaulItems(haulID: String, itemIDs: [String], idempotencyKey _: String) async throws(APIFailure)
        -> Schemas.Haul
    {
        calls.append(.addHaulItems(haulID: haulID, itemIDs: itemIDs))
        guard var haul = haulList.first(where: { $0.id == haulID }) else {
            throw APIFailure.server(404, "not_found", "Haul not found.")
        }
        haul.itemsAdded += Int32(itemIDs.count)
        haul.itemCount = max(haul.itemCount, haul.itemsAdded)
        haulList = haulList.map { $0.id == haulID ? haul : $0 }
        joined(haul, place: Int(haul.itemsAdded) - 1)
        return haul
    }

    func removeHaulItem(haulID: String, itemID _: String) async throws(APIFailure) -> Schemas.Haul {
        calls.append(.removeHaulItem(haulID: haulID))
        guard var haul = haulList.first(where: { $0.id == haulID }) else {
            throw APIFailure.server(404, "not_found", "Haul not found.")
        }
        haul.itemsAdded -= 1
        var item = latestItem ?? Fixtures.item()
        item.haul = nil
        item.version += 1
        haulItem = item
        return haul
    }

    func replaceHaul(haulID: String, with replace: Schemas.HaulReplace) async throws(APIFailure) -> Schemas.Haul {
        calls.append(.replaceHaul(haulID: haulID, count: replace.itemCount))
        guard let old = haulList.first(where: { $0.id == haulID }) else {
            throw APIFailure.server(404, "not_found", "Haul not found.")
        }
        let haul = Fixtures.haul(
            id: haulID,
            totalCents: replace.total.amountCents,
            count: replace.itemCount,
            added: old.itemsAdded,
            source: replace.purchaseSource,
        )
        haulList = haulList.map { $0.id == haulID ? haul : $0 }
        if latestItem?.haul?.id == haulID {
            joined(haul, place: 0)
        }
        return haul
    }

    /// The item in the haul at `place`, with its share as its cost, as the server leaves it.
    private func joined(_ haul: Schemas.Haul, place: Int) {
        var item = latestItem ?? Fixtures.item()
        let total = haul.total.amountCents
        let count = Int64(haul.itemCount)
        item.haul = haul
        item.details.cost = Fixtures.usd(total / count + (Int64(place) < total % count ? 1 : 0))
        item.version += 1
        haulItem = item
    }

    func usage() async throws(APIFailure) -> Schemas.Usage {
        calls.append(.usage)
        return try next(&usageAnswers)
    }

    func interpretVoiceCorrection(itemID _: String, transcript: String, idempotencyKey: String)
        async throws(APIFailure) -> Schemas.VoiceCorrection
    {
        calls.append(.voice(transcript, key: idempotencyKey))
        return try next(&voiceAnswers)
    }

    func marketplacePrefill(itemID _: String, details: Schemas.PrefillDetails) async throws(APIFailure)
        -> Schemas.ItemMarketplacePrefill
    {
        prefillReads.append(details)
        guard var answers = prefillResponses else {
            return Schemas.ItemMarketplacePrefill(itemFields: [], marketplaces: [], questions: 0)
        }
        defer { prefillResponses = answers }
        return try next(&answers)
    }

    func answerPrefill(itemID _: String, answer: Schemas.PrefillAnswer) async throws(APIFailure)
        -> Schemas.ItemMarketplacePrefill
    {
        prefillAnswers.append(answer)
        return try next(&prefillAnswerResponses)
    }

    func marketplaceCategories(itemID _: String, marketplace _: String) async throws(APIFailure)
        -> Schemas.MarketplaceCategories
    {
        Schemas.MarketplaceCategories(likely: [], choices: [])
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
