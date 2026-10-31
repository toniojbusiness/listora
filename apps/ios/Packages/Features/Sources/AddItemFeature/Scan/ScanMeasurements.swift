import Core
import Foundation

/// The run's speed against the plan's targets (docs/features/thrift-scan.md, "Speed"), for the
/// owner in Test mode only: how long each card took from the shutter (median and the slowest
/// 5%), the seller's own active time per item scanned, and how soon the camera is clear for the
/// next shot after Keep or Put back (the median). Sellers never see timings.
struct ScanMeasurements: Equatable {
    /// Targets: a card in 2.5 s at the median, the active time per skipped item 3 s.
    static let cardTarget: TimeInterval = 2.5
    static let activeTarget: TimeInterval = 3

    let cardMedian: TimeInterval?
    let cardP95: TimeInterval?
    let activePerItem: TimeInterval?
    let readyMedian: TimeInterval?

    init(cardTimes: [TimeInterval], active: TimeInterval?, items: Int, readyTimes: [TimeInterval] = []) {
        readyMedian = Self.percentile(readyTimes.sorted(), 0.5)
        let sorted = cardTimes.sorted()
        cardMedian = Self.percentile(sorted, 0.5)
        cardP95 = Self.percentile(sorted, 0.95)
        activePerItem = items > 0 ? active.map { $0 / Double(items) } : nil
    }

    @MainActor
    init(run: ScanRunModel, meter: InteractionMeter) {
        self.init(
            cardTimes: run.cardTimes,
            active: meter.session(run.meterSession)?.active,
            items: run.entries.count,
            readyTimes: run.readyTimes,
        )
    }

    /// "Card 2.1 s · 95% 3.4 s · active 2.8 s an item · next shot 0.3 s", or nil before the
    /// first card.
    var line: String? {
        guard let cardMedian, let cardP95 else { return nil }
        let seconds = { (value: TimeInterval) in value.formatted(.number.precision(.fractionLength(1))) + " s" }
        var parts = ["Card \(seconds(cardMedian))", "95% \(seconds(cardP95))"]
        if let activePerItem {
            parts.append("active \(seconds(activePerItem)) an item")
        }
        if let readyMedian {
            parts.append("next shot \(seconds(readyMedian))")
        }
        return parts.joined(separator: " · ")
    }

    /// The nearest-rank percentile of sorted values.
    static func percentile(_ sorted: [TimeInterval], _ share: Double) -> TimeInterval? {
        guard !sorted.isEmpty else { return nil }
        let rank = Int((share * Double(sorted.count)).rounded(.up))
        return sorted[min(max(rank, 1), sorted.count) - 1]
    }
}
