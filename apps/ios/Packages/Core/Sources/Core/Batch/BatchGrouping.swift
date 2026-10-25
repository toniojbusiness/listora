import Foundation

/// What the iPhone reads from one photo of a batch to tell where one item ends and the next
/// begins: a Vision feature print of the whole image (photos of one item have nearby prints) and
/// how much the photo looks like a close-up of a tag or label.
public struct ShotSignals: Codable, Equatable, Sendable {
    /// The image's feature print; nil when it could not be computed.
    public var featurePrint: [Float]?
    /// 0 to 1: how much the photo looks like a tag or label close-up (mostly printed text).
    public var tagLikelihood: Double

    public init(featurePrint: [Float]?, tagLikelihood: Double) {
        self.featurePrint = featurePrint
        self.tagLikelihood = tagLikelihood
    }

    public var looksLikeTag: Bool {
        tagLikelihood >= 0.5
    }

    /// The Euclidean distance between two feature prints, as Vision's
    /// `VNFeaturePrintObservation.computeDistance` measures it; nil when either is missing or
    /// they come from different feature print versions (their lengths differ).
    public static func distance(_ lhs: [Float]?, _ rhs: [Float]?) -> Double? {
        guard let lhs, let rhs, !lhs.isEmpty, lhs.count == rhs.count else { return nil }
        var sum: Double = 0
        for index in lhs.indices {
            let difference = Double(lhs[index]) - Double(rhs[index])
            sum += difference * difference
        }
        return sum.squareRoot()
    }
}

/// Reads ``ShotSignals`` from a prepared photo, on the device. `PhotoSignalsFeature` implements it
/// with Vision; `AppDependencies` hands it to the features that group photos.
public protocol PhotoSignalReader: Sendable {
    func signals(of imageData: Data) async throws -> ShotSignals
}

/// One photo of a batch, in capture order, as the grouper sees it.
public struct BatchShot: Equatable, Sendable {
    public let id: String
    public let capturedAt: Date
    /// Nil until read (or when reading failed): the grouper then relies on the other signals.
    public let signals: ShotSignals?
    /// The seller tapped Next item (or swiped) before this photo.
    public let startsNewItem: Bool

    public init(id: String, capturedAt: Date, signals: ShotSignals?, startsNewItem: Bool) {
        self.id = id
        self.capturedAt = capturedAt
        self.signals = signals
        self.startsNewItem = startsNewItem
    }
}

/// What a boundary decision rests on.
public enum BoundaryReason: String, Codable, Sendable {
    /// The first photo starts the first item.
    case first
    /// The seller tapped Next item.
    case manual
    /// A tag close-up belongs to the item being shot (front, back, then the tag).
    case tag
    case looksDifferent
    case looksSimilar
    /// The photo before was a tag, which usually ends an item.
    case afterTag
    /// The item has one photo so far: a second is usually its back.
    case secondShot
    /// The item has its front and back already: another full shot is often the next item.
    case extraShot
    /// A long pause before the photo: the seller was laying out the next item.
    case timeGap
    /// There was no feature print to compare (the simulator, or reading failed): only the way the
    /// haul was shot decides, and the seller checks.
    case noSignals
}

/// The grouper's decision between a photo and the one before it.
public struct BoundaryDecision: Equatable, Sendable {
    public let startsNewItem: Bool
    /// 0 to 1: how sure the grouper is of the decision.
    public let confidence: Double
    public let reasons: [BoundaryReason]

    public init(startsNewItem: Bool, confidence: Double, reasons: [BoundaryReason]) {
        self.startsNewItem = startsNewItem
        self.confidence = confidence
        self.reasons = reasons
    }

    /// Below ``BatchGrouper/reviewBelow`` the seller is asked to check the decision.
    public var needsReview: Bool {
        confidence < BatchGrouper.reviewBelow
    }
}

/// A proposed item: its photos in capture order.
public struct ProposedStack: Equatable, Sendable {
    public let shotIDs: [String]
    /// How sure the grouper is that this stack is an item of its own, not the end of the one
    /// before (1 for the first stack and after Next item).
    public let startConfidence: Double
    /// Photos inside the stack that might start another item: the seller is asked to check them.
    public let uncertainShotIDs: [String]

    public init(shotIDs: [String], startConfidence: Double, uncertainShotIDs: [String]) {
        self.shotIDs = shotIDs
        self.startConfidence = startConfidence
        self.uncertainShotIDs = uncertainShotIDs
    }

    public var startNeedsReview: Bool {
        startConfidence < BatchGrouper.reviewBelow
    }
}

/// Splits a batch's photos, in capture order, into one stack per physical item.
///
/// Each photo after the first either starts a new item or joins the one being shot. The seller's
/// Next item always starts one. A photo that looks like a tag joins the current item, since the
/// guide asks for the tag last. Any other photo is compared with the current item's photos that
/// are not tags (the nearest feature print counts), and the way a haul is shot weighs in: the
/// photo right after a tag, a third full shot of an item, and a long pause lean toward a new item,
/// an item's second shot (its back) toward the same one. Look-alike items can be as close as an
/// item's own front and back, so those signals decide, and a close call is flagged. How fast the
/// seller shoots counts only as a long pause: a quick shot right after another is no reason to
/// merge, or a look-alike shot quickly would be merged without a flag.
///
/// Two different items must never be merged quietly: when unsure, the grouper splits, and every
/// decision below ``reviewBelow`` confidence is shown for the seller to check, as is every decision
/// made without a feature print to compare. A wrong split is
/// one tap to merge; a silent merge would list two items as one. The thresholds are calibrated on
/// the synthetic hauls in `PhotoSignalsFeatureTests` (docs/features/batch.md) and should be
/// checked against real hauls.
public enum BatchGrouper {
    /// Feature print distances at or below this read as the same item.
    public static let sameItemBelow = 0.35
    /// Distances at or above this read as a different item.
    public static let differentItemAbove = 0.85
    /// A pause at least this long before a photo leans toward a new item.
    public static let timeGap: TimeInterval = 20
    /// Decisions less sure than this are shown for the seller to check.
    public static let reviewBelow = 0.5
    /// Scores at or above this start a new item: below the middle, so an even call splits.
    static let splitAt = 0.45
    /// How far a score must be from ``splitAt`` for a fully confident decision.
    static let certainAt = 0.25
    static let afterTagWeight = 0.35
    static let secondShotWeight = 0.15
    static let extraShotWeight = 0.15
    static let timeGapWeight = 0.25
    /// The most confidence a decision made without comparing the photos gets: below
    /// ``reviewBelow``, so the seller always checks it.
    static let unseenConfidence = 0.25

    /// One decision per photo, in order; the first always starts the first item.
    public static func decisions(for shots: [BatchShot]) -> [BoundaryDecision] {
        var decisions: [BoundaryDecision] = []
        // The current item's photos that are not tags.
        var currentItem: [ShotSignals] = []
        for (index, shot) in shots.enumerated() {
            if index == 0 || shot.startsNewItem {
                decisions.append(BoundaryDecision(
                    startsNewItem: true,
                    confidence: 1,
                    reasons: [index == 0 ? .first : .manual],
                ))
                currentItem = shot.signals.flatMap { $0.looksLikeTag ? nil : [$0] } ?? []
                continue
            }
            if let signals = shot.signals, signals.looksLikeTag {
                decisions.append(BoundaryDecision(
                    startsNewItem: false,
                    confidence: min(1, 0.5 + signals.tagLikelihood / 2),
                    reasons: [.tag],
                ))
                continue
            }
            let decision = decide(shot, after: shots[index - 1], currentItem: currentItem)
            decisions.append(decision)
            if decision.startsNewItem {
                currentItem = []
            }
            if let signals = shot.signals {
                currentItem.append(signals)
            }
        }
        return decisions
    }

    private static func decide(
        _ shot: BatchShot,
        after previous: BatchShot,
        currentItem: [ShotSignals],
    ) -> BoundaryDecision {
        let distances = currentItem.compactMap { ShotSignals.distance($0.featurePrint, shot.signals?.featurePrint) }
        var score = 0.5
        var reasons: [BoundaryReason] = [.noSignals]
        if let nearest = distances.min() {
            score = min(1, max(0, (nearest - sameItemBelow) / (differentItemAbove - sameItemBelow)))
            reasons = [score >= 0.5 ? .looksDifferent : .looksSimilar]
        }
        if previous.signals?.looksLikeTag == true {
            score += afterTagWeight
            reasons.append(.afterTag)
        }
        if currentItem.count == 1 {
            score -= secondShotWeight
            reasons.append(.secondShot)
        } else if currentItem.count >= 2 {
            score += extraShotWeight
            reasons.append(.extraShot)
        }
        if shot.capturedAt.timeIntervalSince(previous.capturedAt) >= timeGap {
            score += timeGapWeight
            reasons.append(.timeGap)
        }
        let confidence = min(1, abs(score - splitAt) / certainAt)
        return BoundaryDecision(
            startsNewItem: score >= splitAt,
            // Without seeing the photos, the shooting pattern is a guess the seller confirms.
            confidence: reasons.first == .noSignals ? min(confidence, unseenConfidence) : confidence,
            reasons: reasons,
        )
    }

    /// The proposed items, in capture order.
    public static func group(_ shots: [BatchShot]) -> [ProposedStack] {
        var stacks: [ProposedStack] = []
        var ids: [String] = []
        var uncertain: [String] = []
        var startConfidence = 1.0
        for (shot, decision) in zip(shots, decisions(for: shots)) {
            if decision.startsNewItem, !ids.isEmpty {
                stacks.append(ProposedStack(
                    shotIDs: ids,
                    startConfidence: startConfidence,
                    uncertainShotIDs: uncertain,
                ))
                ids = []
                uncertain = []
            }
            if decision.startsNewItem {
                startConfidence = decision.confidence
            } else if decision.needsReview {
                uncertain.append(shot.id)
            }
            ids.append(shot.id)
        }
        if !ids.isEmpty {
            stacks.append(ProposedStack(shotIDs: ids, startConfidence: startConfidence, uncertainShotIDs: uncertain))
        }
        return stacks
    }
}
