import APIClient
import Core
import Foundation
import SwiftUI

/// Everything the review and price screens need, built once at launch by `AppDependencies`.
@MainActor
public final class ReviewEnvironment {
    let service: any ReviewService
    let meter: InteractionMeter
    let listingCopy: ListingCopyStore
    let recentSources: RecentPurchaseSources
    let timing: ReviewTiming
    /// Speech to text for spoken corrections on the review.
    let transcriber: any VoiceTranscriber

    public convenience init(
        apiClient: APIClient,
        meter: InteractionMeter,
        listingCopy: ListingCopyStore,
        transcriber: any VoiceTranscriber,
        defaults: UserDefaults = .standard,
    ) {
        self.init(
            service: APIReviewService(client: apiClient.client),
            meter: meter,
            listingCopy: listingCopy,
            recentSources: RecentPurchaseSources(defaults: defaults),
            transcriber: transcriber,
        )
    }

    init(
        service: any ReviewService,
        meter: InteractionMeter,
        listingCopy: ListingCopyStore,
        recentSources: RecentPurchaseSources,
        transcriber: any VoiceTranscriber,
        timing: ReviewTiming = .standard,
    ) {
        self.service = service
        self.meter = meter
        self.listingCopy = listingCopy
        self.recentSources = recentSources
        self.transcriber = transcriber
        self.timing = timing
    }

    /// Forgets the recent purchase sources (`LISTORA_RESET_LOCAL_DATA`).
    public static func resetLocalData(defaults: UserDefaults = .standard) {
        RecentPurchaseSources(defaults: defaults).reset()
    }

    /// The review flow for one item: analysis progress, review, cost, price, and the saved item.
    /// `onFinished` runs when the seller leaves the saved item ("Done") or asks to change the
    /// photos.
    public func flow(for request: ItemReviewRequest, onFinished: @escaping @MainActor (ItemReviewOutcome) -> Void)
        -> some View
    {
        ReviewFlowView(environment: self, request: request, onFinished: onFinished)
    }

    /// The rapid review of a batch's items (docs/features/batch.md): `onEvent` hears of each saved
    /// item as it is saved, and of the seller finishing.
    public func batchFlow(
        for request: BatchReviewRequest,
        onEvent: @escaping @MainActor (BatchReviewEvent) -> Void,
    ) -> some View {
        BatchReviewView(environment: self, request: request, onEvent: onEvent)
    }

    func makeModel(for request: ItemReviewRequest) -> ReviewFlowModel {
        ReviewFlowModel(
            request: request,
            service: service,
            meter: meter,
            listingCopy: listingCopy,
            recentSources: recentSources,
            timing: timing,
        )
    }
}
