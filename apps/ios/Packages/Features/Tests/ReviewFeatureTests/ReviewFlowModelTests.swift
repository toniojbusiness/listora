import APIClient
import Core
import Foundation
import ListoraAPI
import Testing
@testable import ReviewFeature

/// Loading, photo processing, the analysis, and "Identify harder".
@MainActor
struct ReviewFlowModelTests {
    let harness = ReviewFlowHarness()

    @Test
    func `waits for the photos, analyzes, applies, and shows the review`() async throws {
        await harness.scriptHappyPath()
        let model = harness.model()
        await model.start()

        #expect(model.phase == .reviewing)
        let form = try #require(model.form)
        #expect(form.attention == [.brand, .colors])
        #expect(model.copies.map(\.marketplace) == ["ebay", "depop"])
        #expect(model.identifyHarder == .prominent(reason: "The brand is a guess."))
        #expect(model.premiumQuotaLine == "Uses 1 premium identification. 2 of 10 used this month, 8 left.")
        let calls = await harness.service.calls
        #expect(calls.filter { $0 == .item }.count == 2, "read again until every photo was ready")
        #expect(calls.contains(.apply(Fixtures.fastID, version: 2)))
        #expect(calls.last == .usage)
    }

    @Test
    func `a failed analysis is visible and asking again queues it with a new key`() async {
        await harness.service.setAnalyses(Fixtures.fastID, [.success(Fixtures.analysis(
            status: .failed,
            failure: .init(code: "rate_limited", message: "The AI service is busy. Try again.", retryable: true),
        ))])
        let model = harness.model()
        await model.start()
        #expect(model.phase == .failed(.init(
            title: "Listora couldn't analyze this item",
            message: "The AI service is busy. Try again.",
            canRetry: true,
            suggestsEditingPhotos: false,
        )))

        await harness.service.setAnalyses(Fixtures.fastID, [
            .success(Fixtures.analysis(status: .completed, result: Fixtures.result())),
        ])
        await model.start()
        #expect(model.phase == .reviewing)
        let keys = await harness.service.calls.compactMap { call -> String? in
            if case let .startAnalysis(key) = call {
                key
            } else {
                nil
            }
        }
        #expect(keys.count == 2)
        #expect(Set(keys).count == 2, "a reused key would replay the failed answer")
    }

    @Test
    func `an analysis that needs other photos says so instead of offering a retry`() async {
        await harness.service.setAnalyses(Fixtures.fastID, [.success(Fixtures.analysis(
            status: .failed,
            failure: .init(code: "invalid_output", message: "Listora couldn't read these photos.", retryable: false),
        ))])
        let model = harness.model()
        await model.start()
        guard case let .failed(problem) = model.phase else {
            Issue.record("expected a failure, got \(model.phase)")
            return
        }
        #expect(!problem.canRetry)
        #expect(problem.suggestsEditingPhotos)
    }

    @Test
    func `a photo the server could not process stops with its reason`() async {
        await harness.service.setItems([.success(Fixtures.item(photos: [
            Fixtures.photo(0, status: .ready),
            Fixtures.photo(1, status: .failed, failureReason: "This file is not a JPEG."),
        ]))])
        let model = harness.model()
        await model.start()
        #expect(model.phase == .failed(.init(
            title: "A photo couldn't be processed",
            message: "This file is not a JPEG. Remove or replace that photo, then review the item again.",
            canRetry: false,
            suggestsEditingPhotos: true,
        )))
        #expect(await !harness.service.calls.contains {
            if case .startAnalysis = $0 {
                true
            } else {
                false
            }
        })
    }

    @Test
    func `never waits forever: a slow analysis ends in a retryable failure`() async {
        await harness.service.setAnalyses(Fixtures.fastID, [.success(Fixtures.analysis(status: .running))])
        let model = harness.model()
        await model.start()
        guard case let .failed(problem) = model.phase else {
            Issue.record("expected a timeout, got \(model.phase)")
            return
        }
        #expect(problem.title == "The analysis is taking longer than usual")
        #expect(problem.canRetry)
        let polls = await harness.service.calls.count(where: { $0 == .analysis(Fixtures.fastID) })
        #expect(polls == 4)
    }

    @Test
    func `photos that never finish processing end in a retryable failure`() async {
        await harness.service.setItems([.success(Fixtures.item(photos: [Fixtures.photo(0, status: .processing)]))])
        let model = harness.model()
        await model.start()
        #expect(model.phase == .failed(ReviewFlowError.timedOut(.photos).problem))
    }

    @Test
    func `a refused analysis shows the server's reason`() async {
        await harness.service.setStarts([.failure(.server(
            402,
            "quota_exceeded",
            "This month's AI items in your plan are used up.",
        ))])
        let model = harness.model()
        await model.start()
        #expect(model.phase == .failed(.init(
            title: "Your plan's limit is reached",
            message: "This month's AI items in your plan are used up.",
            canRetry: false,
            suggestsEditingPhotos: false,
        )), "the photos are fine, so the way out is Go back, not Edit photos")
    }

    @Test
    func `asks again while the server says a photo is still processing`() async {
        await harness.service.setStarts([
            .failure(.server(409, "invalid_state_transition", "Some photos are still processing.")),
            .success(Fixtures.analysis(status: .completed, result: Fixtures.result())),
        ])
        let model = harness.model()
        await model.start()
        #expect(model.phase == .reviewing)
    }

    @Test
    func `reopening an item it already applied to these photos goes straight to the review`() async {
        await harness.service.setItems([.success(Fixtures.appliedItem())])
        await harness.service.setStarts([
            .success(Fixtures.analysis(status: .completed, result: Fixtures.result())),
        ])
        let model = harness.model()
        await model.start()
        #expect(model.phase == .reviewing)
        #expect(model.analysis?.id == Fixtures.fastID)
        #expect(model.fastAnalysisID == Fixtures.fastID)
        #expect(await !harness.service.calls.contains {
            if case .apply = $0 {
                true
            } else {
                false
            }
        }, "the server already has its details")
    }

    @Test
    func `reopening an item identified with premium reviews the premium details`() async {
        await harness.service.setItems([.success(Fixtures.appliedItem(acceptedAnalysisID: Fixtures.premiumID))])
        await harness.service.setStarts([.success(Fixtures.analysis(
            status: .completed,
            result: Fixtures.result(),
            escalation: Fixtures.premiumID,
        ))])
        await harness.service.setAnalyses(Fixtures.premiumID, [.success(Fixtures.analysis(
            id: Fixtures.premiumID,
            tier: .premium,
            status: .completed,
            result: Fixtures.result(needsEscalation: false),
            escalatedFrom: Fixtures.fastID,
        ))])
        let model = harness.model()
        await model.start()
        #expect(model.phase == .reviewing)
        #expect(model.analysis?.id == Fixtures.premiumID)
        #expect(model.fastAnalysisID == Fixtures.fastID)
        #expect(model.escalation == .finished)
    }

    @Test
    func `reopening an item whose photos changed analyzes the new photos`() async {
        await harness.service.setItems([.success(Fixtures.appliedItem())])
        await harness.service.setStarts([.success(Fixtures.analysis(id: Fixtures.newPhotosID, status: .queued))])
        await harness.service.setAnalyses(Fixtures.newPhotosID, [
            .success(Fixtures.analysis(id: Fixtures.newPhotosID, status: .completed, result: Fixtures.result())),
        ])
        await harness.service.setApplies([.success(Fixtures.appliedItem(
            version: 4,
            acceptedAnalysisID: Fixtures.newPhotosID,
        ))])
        let model = harness.model()
        await model.start()
        #expect(model.phase == .reviewing)
        #expect(model.analysis?.id == Fixtures.newPhotosID)
        #expect(model.fastAnalysisID == Fixtures.newPhotosID, "Identify harder escalates the new photos' analysis")
        let calls = await harness.service.calls
        #expect(calls.contains(.apply(Fixtures.newPhotosID, version: 3)))
        #expect(!calls.contains(.analysis(Fixtures.fastID)), "the old photos' analysis is not reviewed")
    }

    @Test
    func `reopening a saved item shows it saved`() async {
        var item = Fixtures.appliedItem()
        item.status = .init(value1: .ready, value2: "ready")
        item.details.listPrice = Fixtures.usd(2600)
        await harness.service.setItems([.success(item)])
        let model = harness.model()
        await model.start()
        #expect(model.phase == .alreadySaved)
        #expect(model.saved == .init(
            sku: "AJ-000184",
            title: "Acme Outfitters flannel shirt, men's M",
            price: "$26.00",
            summary: nil,
        ))
    }
}
