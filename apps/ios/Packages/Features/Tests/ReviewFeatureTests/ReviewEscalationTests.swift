import APIClient
import Core
import Foundation
import ListoraAPI
import Testing
@testable import ReviewFeature

/// "Identify harder": the premium identification, asked for or started by the server.
@MainActor
struct ReviewEscalationTests {
    let harness = ReviewFlowHarness()

    @Test
    func `identifying harder saves edits first, then applies the premium details and refreshes the quota`(
    ) async throws {
        await harness.scriptHappyPath()
        let model = harness.model()
        await model.start()
        model.update(.colors, to: .list(["red"]))

        var premiumResult = Fixtures.result(needsEscalation: false)
        premiumResult.details.brand = Fixtures.text("Acme Outfitters", 0.92, .ocr)
        await harness.service.setEscalations([.success(Fixtures.analysis(
            id: Fixtures.premiumID,
            tier: .premium,
            status: .queued,
            escalatedFrom: Fixtures.fastID,
        ))])
        await harness.service.setAnalyses(Fixtures.premiumID, [
            .success(Fixtures.analysis(
                id: Fixtures.premiumID,
                tier: .premium,
                status: .completed,
                result: premiumResult,
                escalatedFrom: Fixtures.fastID,
            )),
        ])
        await harness.service.setApplies([.success(Fixtures.appliedItem(
            version: 5,
            acceptedAnalysisID: Fixtures.premiumID,
        ))])
        await harness.service.setUsage([.success(Fixtures.usage(premiumUsed: 3, limit: 10))])
        await model.startIdentifyHarder()

        #expect(model.escalation == .finished)
        #expect(model.analysis?.tier == .premium)
        #expect(model.identifyHarder == nil, "the item is already identified with premium")
        #expect(model.form?.attention == [.colors], "the premium brand is sure; the order is rebuilt")
        #expect(model.premiumQuotaLine == "Uses 1 premium identification. 3 of 10 used this month, 7 left.")
        let calls = await harness.service.calls
        let replace = calls.firstIndex {
            if case .replace = $0 {
                true
            } else {
                false
            }
        }
        let escalate = calls.firstIndex(of: .escalate(Fixtures.fastID))
        #expect(
            try replace != nil && escalate != nil && #require(replace) < #require(escalate),
            "edits are saved before escalating",
        )
        #expect(await harness.service.replacements.first?.details.colors == ["red"])
        #expect(calls.contains(.apply(Fixtures.premiumID, version: 4)))
    }

    @Test
    func `a refused premium identification shows why and keeps the review`() async {
        await harness.scriptHappyPath()
        let model = harness.model()
        await model.start()
        await harness.service.setEscalations([.failure(.server(
            402,
            "quota_exceeded",
            "This month's premium identifications in your plan are used up.",
        ))])
        await model.startIdentifyHarder()
        #expect(model.escalation == .failed(
            message: "This month's premium identifications in your plan are used up.",
            canRetry: false,
        ))
        #expect(model.phase == .reviewing)
    }

    @Test
    func `used-up premium identifications say so and Identify harder does not ask the server`() async {
        await harness.scriptHappyPath()
        await harness.service.setUsage([.success(Fixtures.usage(premiumUsed: 10, limit: 10))])
        let model = harness.model()
        await model.start()
        #expect(model.isPremiumQuotaUsedUp)
        #expect(model.premiumQuotaLine == "All 10 premium identifications in your plan are used this month.")
        await model.startIdentifyHarder()
        #expect(model.escalation == .idle)
        #expect(await !harness.service.calls.contains(.escalate(Fixtures.fastID)))
    }

    @Test
    func `follows a premium identification the server started on its own`() async throws {
        await harness.service.setAnalyses(Fixtures.fastID, [.success(Fixtures.analysis(
            status: .completed,
            result: Fixtures.result(),
            escalation: Fixtures.premiumID,
        ))])
        await harness.service.setAnalyses(Fixtures.premiumID, [
            .success(Fixtures.analysis(id: Fixtures.premiumID, tier: .premium, status: .running)),
            .success(Fixtures.analysis(
                id: Fixtures.premiumID,
                tier: .premium,
                status: .completed,
                result: Fixtures.result(needsEscalation: false),
            )),
        ])
        let model = harness.model()
        await model.start()
        #expect(model.escalation == .running)
        for _ in 0 ..< 200 where model.escalation == .running {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(model.escalation == .finished)
        #expect(model.analysis?.id == Fixtures.premiumID)
    }
}
