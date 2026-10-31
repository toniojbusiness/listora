import Foundation

/// The sourcing kit (`GET /v1/sourcing/kit`, docs/features/thrift-scan.md): the household's own
/// sales grouped by brand, then brand and category, then size, kept on this iPhone so a scan at
/// the store can be called with no signal. Decoded from the API's JSON as it is; only what the
/// offline call reads.
public struct SourcingKit: Codable, Equatable, Sendable {
    /// The kit format this app reads (``OfflineScanCall`` ignores any other).
    public static let supportedVersion = 2

    public struct Money: Codable, Equatable, Sendable {
        public let amountCents: Int
        public let currency: String

        public init(amountCents: Int, currency: String = "USD") {
            self.amountCents = amountCents
            self.currency = currency
        }
    }

    /// The call's thresholds, the server's.
    public struct Call: Codable, Equatable, Sendable {
        public let worthListing: Money
        public let minComparisons: Int

        public init(worthListing: Money, minComparisons: Int) {
            self.worthListing = worthListing
            self.minComparisons = minComparisons
        }
    }

    /// A group's sales the call may rest on (never eBay's), with their payouts after the fees of
    /// `payoutMarketplace`, as the server works them out.
    public struct ForCall: Codable, Equatable, Sendable {
        public let soldCount: Int
        public let low: Money
        public let high: Money
        public let payoutMarketplace: String
        public let conservativePayout: Money
        public let optimisticPayout: Money

        public init(
            soldCount: Int,
            low: Money,
            high: Money,
            payoutMarketplace: String,
            conservativePayout: Money,
            optimisticPayout: Money,
        ) {
            self.soldCount = soldCount
            self.low = low
            self.high = high
            self.payoutMarketplace = payoutMarketplace
            self.conservativePayout = conservativePayout
            self.optimisticPayout = optimisticPayout
        }
    }

    /// One group: a brand, or a brand and category, or those and a size.
    public struct Bucket: Codable, Equatable, Sendable {
        /// As the household's sales spell it most often.
        public let brand: String
        /// ``BrandKey`` of the brand.
        public let brandKey: String
        public let category: String?
        public let sizeBucket: String?
        /// The household's items of the group in inventory, not sold.
        public let unsoldCount: Int
        public let forCall: ForCall?

        public init(
            brand: String,
            brandKey: String,
            category: String? = nil,
            sizeBucket: String? = nil,
            unsoldCount: Int,
            forCall: ForCall?,
        ) {
            self.brand = brand
            self.brandKey = brandKey
            self.category = category
            self.sizeBucket = sizeBucket
            self.unsoldCount = unsoldCount
            self.forCall = forCall
        }
    }

    public let version: Int
    /// When the server made it (ISO 8601, as the API sends it).
    public let generatedAt: String
    public let call: Call
    public let buckets: [Bucket]

    public init(version: Int, generatedAt: String, call: Call, buckets: [Bucket]) {
        self.version = version
        self.generatedAt = generatedAt
        self.call = call
        self.buckets = buckets
    }
}
