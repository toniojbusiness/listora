import Foundation

/// The scan's instant read with no signal (docs/features/thrift-scan.md, "Offline at the bins"):
/// the brand printed on the tag, looked up in the ``SourcingKit``, and the call from the
/// household's own sales of it alone. This app's copy of `offlineScanCall` in @listora/sourcing,
/// kept equal by the golden cases both test suites run (`OfflineScanCallTests`).
public struct OfflineScanRead: Codable, Equatable, Sendable {
    public enum Call: String, Codable, Sendable {
        case buy
        case yourCall = "your_call"
        case skip
    }

    public enum Confidence: String, Codable, Sendable {
        case high
        case medium
        case low
    }

    public enum Basis: String, Codable, Sendable {
        case ownHistory = "own_history"
        case none
    }

    /// As the household's sales spell it, and its ``BrandKey``.
    public let brand: String
    public let brandKey: String
    public let call: Call
    public let confidence: Confidence
    public let basis: Basis
    public let lowCents: Int?
    public let highCents: Int?
    public let conservativePayoutCents: Int?
    public let optimisticPayoutCents: Int?
    public let payoutMarketplace: String?
    /// What the call rests on, as the seller reads it ("Your 5 Lululemon sales").
    public let basedOn: String
    /// The household's items of the brand in inventory, not sold.
    public let unsoldCount: Int
}

public enum OfflineScanCall {
    /// Shown with every offline call: it rests on the household's own sales and nothing else.
    public static let label = "From your sales only"
    /// The longest run of words a brand is read from, so a long line stays cheap.
    static let maxCandidateWords = 4

    /// The kit's brand group the tag text names: each line in reading order, each word of it in
    /// order, the first whose ``BrandKey`` (of that word and the few after it) is a brand of the
    /// kit. Only brand groups count: the tag cannot give a category.
    public static func brandBucket(in kit: SourcingKit, tagText: [String]) -> SourcingKit.Bucket? {
        var brands: [String: SourcingKit.Bucket] = [:]
        for bucket in kit.buckets where bucket.category == nil && bucket.sizeBucket == nil {
            brands[bucket.brandKey] = bucket
        }
        for line in tagText {
            let words = line.split(whereSeparator: \.isWhitespace).map(String.init)
            for start in words.indices {
                let candidate = words[start ..< min(start + maxCandidateWords, words.count)].joined(separator: " ")
                if let key = BrandKey.of(candidate), let bucket = brands[key] {
                    return bucket
                }
            }
        }
        return nil
    }

    /// The offline call of a scan whose tag names a brand of the kit; nil for a kit of another
    /// format or a tag naming none of its brands. The printed brand counts as a sure read, but
    /// with no category the household's sales match on the brand alone, which never makes a
    /// high-confidence call: enough of them give a range at medium confidence, called by the
    /// server's rule with no flags (nothing saw the item); fewer give Your call, low confidence.
    public static func read(kit: SourcingKit, tagText: [String]) -> OfflineScanRead? {
        guard kit.version == SourcingKit.supportedVersion,
              let bucket = brandBucket(in: kit, tagText: tagText)
        else { return nil }
        guard let sales = bucket.forCall, sales.soldCount >= kit.call.minComparisons else {
            return OfflineScanRead(
                brand: bucket.brand,
                brandKey: bucket.brandKey,
                call: .yourCall,
                confidence: .low,
                basis: .none,
                lowCents: nil,
                highCents: nil,
                conservativePayoutCents: nil,
                optimisticPayoutCents: nil,
                payoutMarketplace: nil,
                basedOn: "Not enough of your \(bucket.brand) sales to go on",
                unsoldCount: bucket.unsoldCount,
            )
        }
        let confidence = OfflineScanRead.Confidence.medium
        let conservative = sales.conservativePayout.amountCents
        let optimistic = sales.optimisticPayout.amountCents
        return OfflineScanRead(
            brand: bucket.brand,
            brandKey: bucket.brandKey,
            call: decide(
                conservativePayoutCents: conservative,
                optimisticPayoutCents: optimistic,
                confidence: confidence,
                flagged: false,
                worthListingCents: kit.call.worthListing.amountCents,
            ),
            confidence: confidence,
            basis: .ownHistory,
            lowCents: sales.low.amountCents,
            highCents: sales.high.amountCents,
            conservativePayoutCents: conservative,
            optimisticPayoutCents: optimistic,
            payoutMarketplace: sales.payoutMarketplace,
            basedOn: "Your \(sales.soldCount) \(bucket.brand) sales",
            unsoldCount: bucket.unsoldCount,
        )
    }

    /// The server's rule (`decideCall`): Skip when even the optimistic payout is under the
    /// worth-listing amount; Buy when the conservative one reaches it at medium or high
    /// confidence with no flag; Your call otherwise.
    static func decide(
        conservativePayoutCents: Int,
        optimisticPayoutCents: Int,
        confidence: OfflineScanRead.Confidence,
        flagged: Bool,
        worthListingCents: Int,
    ) -> OfflineScanRead.Call {
        if optimisticPayoutCents < worthListingCents {
            return .skip
        }
        return conservativePayoutCents >= worthListingCents && confidence != .low && !flagged ? .buy : .yourCall
    }
}
