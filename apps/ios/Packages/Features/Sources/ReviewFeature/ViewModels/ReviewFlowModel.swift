import APIClient
import Core
import Foundation
import ListoraAPI
import Observation
import os

/// How often the flow asks the server how photos and analyses are doing, and when it stops
/// waiting. Every wait ends: in the review, or in a failure the seller can retry.
struct ReviewTiming: Sendable {
    var pollInterval: Duration = .seconds(1)
    /// Polls for the server to process the photos before giving up.
    var photoPolls = 90
    /// Polls after which the analysis counts as slow ("taking longer than usual").
    var slowAnalysisPolls = 20
    /// Polls for the analysis before giving up.
    var analysisPolls = 120

    static let standard = ReviewTiming()
}

/// One item's review, cost, price, and save: the state of every screen of the flow and the
/// requests behind them. Each step saves to the server before the next screen opens, so a
/// relaunch picks up where the server is.
@MainActor
@Observable
final class ReviewFlowModel {
    enum Phase: Equatable {
        /// Reading the item.
        case loading
        /// The server is still making the photos' derivatives.
        case preparingPhotos(ready: Int, total: Int)
        case analyzing(slow: Bool)
        case failed(Problem)
        case reviewing
        /// The item was saved before (the flow was reopened after its save).
        case alreadySaved
    }

    /// Why the flow stopped, in words the seller can act on.
    struct Problem: Equatable {
        let title: String
        let message: String
        /// Asking again may succeed without changing anything.
        let canRetry: Bool
        /// The photos have to change (a photo failed, or the analysis needs other photos).
        let suggestsEditingPhotos: Bool
    }

    enum Escalation: Equatable {
        case idle
        /// The premium identification is running.
        case running
        case failed(message: String, canRetry: Bool)
        /// The premium identification's details are applied.
        case finished
    }

    enum PricingState: Equatable {
        case idle
        case loading
        case loaded(PricingPresentation)
        case failed(String)
    }

    enum PriceChoice: Equatable {
        case tier(Components.Schemas.PriceTierName)
        case custom(Int64)
    }

    struct CostDraft: Equatable {
        var amount = AmountEntry()
        var purchaseDate: Date
        var source = ""
    }

    struct SavedItem: Equatable {
        let sku: String
        let title: String?
        let price: String?
        /// The interaction metric, when this flow measured the item.
        let summary: InteractionSummary?
    }

    let request: ItemReviewRequest
    let service: any ReviewService
    let meter: InteractionMeter
    let listingCopy: ListingCopyStore
    let recentSources: RecentPurchaseSources
    let timing: ReviewTiming
    let sleep: @Sendable (Duration) async throws -> Void
    let log = Logger(subsystem: "com.listora.app", category: "review")

    private(set) var phase: Phase = .loading
    var item: Item?
    var form: ReviewForm?
    var copies: [MarketplaceCopy] = []
    /// The analysis whose details the form shows.
    var analysis: Analysis?
    /// The fast analysis, which "Identify harder" escalates.
    var fastAnalysisID: String?
    var escalation: Escalation = .idle
    var usage: Usage?
    var cost: CostDraft
    var pricing: PricingState = .idle
    var priceChoice: PriceChoice?
    var saved: SavedItem?
    /// A step's request is running (Continue and Save show progress).
    var isWorking = false
    /// A step failed; shown in an alert, and the seller stays on the screen.
    var actionError: String?
    var showsCost = false
    var showsPrice = false
    var showsSaved = false
    private var pipeline: Task<Void, Never>?

    init(
        request: ItemReviewRequest,
        service: any ReviewService,
        meter: InteractionMeter,
        listingCopy: ListingCopyStore,
        recentSources: RecentPurchaseSources,
        timing: ReviewTiming = .standard,
        today: Date = Date(),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
    ) {
        self.request = request
        self.service = service
        self.meter = meter
        self.listingCopy = listingCopy
        self.recentSources = recentSources
        self.timing = timing
        self.sleep = sleep
        cost = CostDraft(purchaseDate: today)
    }

    // MARK: Loading and analysis

    /// Loads the item and runs whatever it still needs: photo processing, the analysis, applying
    /// it. Safe to call again (Try again): every step is idempotent on the server.
    func start() async {
        if let pipeline {
            await pipeline.value
            return
        }
        let task = Task { await runPipeline() }
        pipeline = task
        await task.value
        pipeline = nil
    }

    private func runPipeline() async {
        phase = .loading
        meter.setWaiting(true, for: request.sessionID)
        defer { meter.setWaiting(false, for: request.sessionID) }
        do {
            var item = try await service.item(id: request.itemID)
            self.item = item
            if !Self.isDraft(item) {
                saved = SavedItem(
                    sku: item.sku,
                    title: item.details.title,
                    price: item.details.listPrice.map(Formatting.money),
                    summary: nil,
                )
                phase = .alreadySaved
                return
            }
            if let acceptedID = item.details.acceptedAnalysisId {
                // Applied before (the flow was reopened): review what it proposed.
                let accepted = try await service.analysis(id: acceptedID)
                let fastID = accepted.tier == .premium ? accepted.escalatedFromAnalysisId : accepted.id
                await enterReview(item: item, analysis: accepted, fastAnalysisID: fastID)
                return
            }
            item = try await waitForPhotos(item)
            let started = try await startAnalysis()
            let finished = try await waitForAnalysis(started, showsProgress: true)
            guard finished.status == .completed else {
                phase = .failed(Self.problem(analysisFailure: finished.failure))
                return
            }
            item = try await apply(finished, to: item)
            await enterReview(item: item, analysis: finished, fastAnalysisID: finished.id)
        } catch let failure as ReviewFlowError {
            phase = .failed(failure.problem)
        } catch let failure as APIFailure {
            log.error("Review failed: \(failure.code, privacy: .public) \(failure.message, privacy: .public)")
            phase = .failed(Self.problem(failure))
        } catch {
            phase = .failed(Self.problem(APIFailure(error)))
        }
    }

    static func isDraft(_ item: Item) -> Bool {
        item.status.value1 == .draft
    }

    /// Waits until the server has processed every photo; a failed photo stops the flow.
    private func waitForPhotos(_ item: Item) async throws -> Item {
        var item = item
        for _ in 0 ..< timing.photoPolls {
            let photos = item.photos
            if let failed = photos.first(where: { $0.status == .failed }) {
                throw ReviewFlowError.photoFailed(reason: failed.failureReason)
            }
            let ready = photos.count(where: { $0.status == .ready })
            if !photos.isEmpty, ready == photos.count {
                return item
            }
            phase = .preparingPhotos(ready: ready, total: photos.count)
            try await sleep(timing.pollInterval)
            item = try await service.item(id: request.itemID)
            self.item = item
        }
        throw ReviewFlowError.timedOut(.photos)
    }

    /// Starts the fast analysis. A request the server refuses because a photo is still processing
    /// is asked again.
    private func startAnalysis() async throws -> Analysis {
        phase = .analyzing(slow: false)
        // A new key per attempt: asking again is how a failed analysis is queued again, and a
        // reused key would replay the first answer instead.
        let key = UUID().uuidString.lowercased()
        for _ in 0 ..< timing.photoPolls {
            do {
                return try await service.startAnalysis(itemID: request.itemID, idempotencyKey: key)
            } catch let failure where failure.knownCode == .invalidStateTransition {
                try await sleep(timing.pollInterval)
            }
        }
        throw ReviewFlowError.timedOut(.photos)
    }

    /// Polls an analysis until it completes or fails.
    func waitForAnalysis(_ analysis: Analysis, showsProgress: Bool) async throws -> Analysis {
        var analysis = analysis
        var polls = 0
        while analysis.status == .queued || analysis.status == .running {
            guard polls < timing.analysisPolls else { throw ReviewFlowError.timedOut(.analysis) }
            if showsProgress {
                phase = .analyzing(slow: polls >= timing.slowAnalysisPolls)
            }
            try await sleep(timing.pollInterval)
            polls += 1
            analysis = try await service.analysis(id: analysis.id)
        }
        return analysis
    }

    /// Copies the analysis's details into the item. A version conflict (the item changed since it
    /// was read) reads the item again and applies once more.
    func apply(_ analysis: Analysis, to item: Item) async throws -> Item {
        do {
            return try await service.apply(
                analysisID: analysis.id,
                expectedVersion: item.version,
                idempotencyKey: UUID().uuidString.lowercased(),
            )
        } catch let failure where failure.knownCode == .versionConflict {
            let latest = try await service.item(id: request.itemID)
            return try await service.apply(
                analysisID: analysis.id,
                expectedVersion: latest.version,
                idempotencyKey: UUID().uuidString.lowercased(),
            )
        }
    }

    /// Shows the review of `analysis`'s details, and follows a premium identification the server
    /// already started.
    func enterReview(item: Item, analysis: Analysis, fastAnalysisID: String?) async {
        self.item = item
        self.analysis = analysis
        self.fastAnalysisID = fastAnalysisID
        form = ReviewForm(item: item, result: analysis.result)
        copies = MarketplaceCopy.copies(result: analysis.result, edits: listingCopy.edits(itemID: item.id))
        if let cents = item.details.cost?.amountCents, cost.amount.isEmpty {
            cost.amount = AmountEntry(cents: cents)
        }
        if let date = item.details.purchaseDate.flatMap(Self.date(fromDay:)) {
            cost.purchaseDate = date
        }
        if let source = item.details.purchaseSource {
            cost.source = source
        }
        if analysis.tier == .premium {
            escalation = .finished
        }
        phase = .reviewing
        usage = try? await service.usage()
        if analysis.tier == .fast, let premiumID = analysis.escalationAnalysisId {
            // The server started the premium identification on its own (AI_AUTO_ESCALATE).
            followEscalation(premiumID)
        }
    }
}

extension ReviewFlowModel {
    // MARK: Problems

    static func problem(_ failure: APIFailure) -> Problem {
        Problem(
            title: "Something went wrong",
            message: failure.message,
            canRetry: failure.retryable || failure.statusCode == nil,
            suggestsEditingPhotos: false,
        )
    }

    static func problem(analysisFailure failure: Components.Schemas.AnalysisFailure?) -> Problem {
        guard let failure else {
            return Problem(
                title: "Listora couldn't analyze this item",
                message: "The analysis stopped without a reason. Try again.",
                canRetry: true,
                suggestsEditingPhotos: false,
            )
        }
        return Problem(
            title: "Listora couldn't analyze this item",
            message: failure.message,
            canRetry: failure.retryable,
            suggestsEditingPhotos: !failure.retryable,
        )
    }

    // MARK: Dates

    private static let dayFormat = Date.ISO8601FormatStyle(timeZone: .current).year().month().day()

    /// `YYYY-MM-DD` in the seller's time zone, the contract's `format: date`.
    static func day(_ date: Date) -> String {
        date.formatted(dayFormat)
    }

    static func date(fromDay day: String) -> Date? {
        try? dayFormat.parse(day)
    }
}

/// Why the flow stopped, before it becomes a ``ReviewFlowModel/Problem``.
enum ReviewFlowError: Error, Equatable {
    enum Stage: Equatable {
        case photos
        case analysis
    }

    case photoFailed(reason: String?)
    case timedOut(Stage)

    var problem: ReviewFlowModel.Problem {
        switch self {
        case let .photoFailed(reason):
            ReviewFlowModel.Problem(
                title: "A photo couldn't be processed",
                message: [reason, "Remove or replace that photo, then review the item again."]
                    .compactMap(\.self).joined(separator: " "),
                canRetry: false,
                suggestsEditingPhotos: true,
            )
        case .timedOut(.photos):
            ReviewFlowModel.Problem(
                title: "Your photos are taking longer than usual",
                message: "Listora is still getting them ready. Try again in a moment.",
                canRetry: true,
                suggestsEditingPhotos: false,
            )
        case .timedOut(.analysis):
            ReviewFlowModel.Problem(
                title: "The analysis is taking longer than usual",
                message: "It keeps running on Listora. Try again in a moment to see the result.",
                canRetry: true,
                suggestsEditingPhotos: false,
            )
        }
    }
}
