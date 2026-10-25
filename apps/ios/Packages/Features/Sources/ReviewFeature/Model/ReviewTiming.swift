import Foundation

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
