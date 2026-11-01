import Foundation

/// The sourcing kit (`GET /v1/sourcing/kit`, docs/features/thrift-scan.md): the household's own
/// sales grouped by brand, then brand and category, then size, kept on this iPhone so a scan at
/// the store can be called with no signal, and the same sales read as advice (``Insights``).
/// Decoded from the API's JSON as it is; only what the app reads.
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

    /// One brand and item type pair of "What sells for you", from the household's own sales and
    /// stock: never a brand alone.
    public struct InsightGroup: Codable, Equatable, Sendable {
        public let brand: String
        public let brandKey: String
        /// The canonical category path: the item type.
        public let category: String
        /// Sold in the kit's window.
        public let soldCount: Int
        /// In stock and added at least 30 days ago: given time to sell.
        public let unsoldCount: Int
        /// Every one in stock now, however new.
        public let inStockCount: Int
        public let sellThroughBasisPoints: Int
        /// From the first listing through Listora to the sale; nil without two such sales.
        public let medianDaysToSell: Int?
        /// After each marketplace's estimated fees; nil with only eBay's sales.
        public let medianPayout: Money?

        public init(
            brand: String,
            brandKey: String,
            category: String,
            soldCount: Int,
            unsoldCount: Int,
            inStockCount: Int,
            sellThroughBasisPoints: Int,
            medianDaysToSell: Int? = nil,
            medianPayout: Money? = nil,
        ) {
            self.brand = brand
            self.brandKey = brandKey
            self.category = category
            self.soldCount = soldCount
            self.unsoldCount = unsoldCount
            self.inStockCount = inStockCount
            self.sellThroughBasisPoints = sellThroughBasisPoints
            self.medianDaysToSell = medianDaysToSell
            self.medianPayout = medianPayout
        }
    }

    /// "What sells for you" (docs/features/thrift-scan.md, "Sourcing insights"), as the server
    /// worked it out.
    public struct Insights: Codable, Equatable, Sendable {
        /// The sales with a brand and category it rests on.
        public let soldCount: Int
        /// Those with a known day count (listed through Listora).
        public let daysToSellCount: Int
        public let lookFor: [InsightGroup]
        public let best: [InsightGroup]
        public let worst: [InsightGroup]

        public init(
            soldCount: Int,
            daysToSellCount: Int,
            lookFor: [InsightGroup],
            best: [InsightGroup],
            worst: [InsightGroup],
        ) {
            self.soldCount = soldCount
            self.daysToSellCount = daysToSellCount
            self.lookFor = lookFor
            self.best = best
            self.worst = worst
        }

        /// Nothing to show yet: too few sales and stock for any pair.
        public var isEmpty: Bool {
            lookFor.isEmpty && best.isEmpty && worst.isEmpty
        }
    }

    public let version: Int
    /// When the server made it (ISO 8601, as the API sends it).
    public let generatedAt: String
    public let call: Call
    public let buckets: [Bucket]
    /// Nil in a kit an earlier build of the app kept.
    public let insights: Insights?

    public init(version: Int, generatedAt: String, call: Call, buckets: [Bucket], insights: Insights? = nil) {
        self.version = version
        self.generatedAt = generatedAt
        self.call = call
        self.buckets = buckets
        self.insights = insights
    }
}
