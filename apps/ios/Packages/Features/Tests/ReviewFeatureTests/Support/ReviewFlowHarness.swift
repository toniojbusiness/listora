import APIClient
import Core
import Foundation
import ListoraAPI
@testable import ReviewFeature

/// A review flow over a ``FakeReviewService``, with the meter, stores, and request it needs.
@MainActor
struct ReviewFlowHarness {
    let service = FakeReviewService()
    let meter: InteractionMeter
    let defaults = UserDefaults(suiteName: "ReviewFlowTests-\(UUID().uuidString)") ?? .standard
    let listingCopy = ListingCopyStore(directory: URL.temporaryDirectory.appending(path: "copy-\(UUID().uuidString)"))
    let request = ItemReviewRequest(sessionID: "draft-1", itemID: Fixtures.itemID, sku: "AJ-000184")

    static let timing = ReviewTiming(pollInterval: .zero, photoPolls: 5, slowAnalysisPolls: 2, analysisPolls: 4)

    init(meter: InteractionMeter = InteractionMeter(storage: InMemoryInteractionStorage())) {
        self.meter = meter
    }

    func model(
        sleep: @escaping @Sendable (Duration) async throws -> Void = { _ in await Task.yield() },
    ) -> ReviewFlowModel {
        ReviewFlowModel(
            request: request,
            service: service,
            meter: meter,
            listingCopy: listingCopy,
            recentSources: RecentPurchaseSources(defaults: defaults),
            timing: Self.timing,
            today: Fixtures.date,
            sleep: sleep,
        )
    }

    /// The server finishes processing the photos, then the analysis runs and completes.
    func scriptHappyPath() async {
        await service.setItems([
            .success(Fixtures.item(photos: [
                Fixtures.photo(0, status: .ready),
                Fixtures.photo(1, status: .processing),
            ])),
            .success(Fixtures.item()),
        ])
        await service.setAnalyses(Fixtures.fastID, [
            .success(Fixtures.analysis(status: .running)),
            .success(Fixtures.analysis(status: .completed, result: Fixtures.result())),
        ])
    }
}

@MainActor
final class TestClock {
    var now = Fixtures.date

    func advance(_ seconds: TimeInterval) {
        now = now.addingTimeInterval(seconds)
    }
}
