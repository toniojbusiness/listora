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

    public convenience init(
        apiClient: APIClient,
        meter: InteractionMeter,
        listingCopy: ListingCopyStore,
        defaults: UserDefaults = .standard,
    ) {
        self.init(
            service: APIReviewService(client: apiClient.client),
            meter: meter,
            listingCopy: listingCopy,
            recentSources: RecentPurchaseSources(defaults: defaults),
        )
    }

    init(
        service: any ReviewService,
        meter: InteractionMeter,
        listingCopy: ListingCopyStore,
        recentSources: RecentPurchaseSources,
        timing: ReviewTiming = .standard,
    ) {
        self.service = service
        self.meter = meter
        self.listingCopy = listingCopy
        self.recentSources = recentSources
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
