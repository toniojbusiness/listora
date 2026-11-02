import DesignSystem
import Foundation
import ListoraAPI

/// A scan's answer as its card shows it (docs/features/thrift-scan.md, "The card"): the verdict
/// (Grab, Maybe, Leave) with its one-line why, what the item is, the three prices, and a short
/// reality check of what they rest on. While the prices wait for what they rest on, only what
/// the item is and a quiet "Checking prices" line. Every price is in whole dollars; "sold" is
/// only ever the server's words next to real sold data.
struct ScanCard: Equatable, Sendable {
    enum Call: Equatable, Sendable {
        case buy
        case yourCall
        case skip
        /// The prices and the call wait for the web research and the comparisons.
        case checking
        /// A call added after this build: shown by its label, felt as nothing.
        case other
    }

    /// One marketplace's own sales: "Depop · 3 sold · $25-$29".
    struct OwnSales: Equatable, Sendable {
        let marketplace: String
        let label: String
        let summary: String
        /// Shown, but never feeding the call (eBay's).
        let displayOnly: Bool
    }

    /// What else the call weighed: "Retail about $98", with what it rests on.
    struct Signal: Equatable, Sendable {
        /// `KnownScanSignalKind`'s raw value: `asking` and `demand` show with their comparison.
        var kind: String = ""
        let label: String
        let basedOn: String

        /// What it rests on, without the web info label the card shows above it.
        var shortBasedOn: String {
            let prefix = "Web info - not sold listings: "
            return basedOn.hasPrefix(prefix) ? String(basedOn.dropFirst(prefix.count)) : basedOn
        }
    }

    /// What the web said (the research), always under its label: never sold prices.
    struct WebInfo: Equatable, Sendable {
        let label: String
        let summary: String?
        /// "Asks $30-$50 on poshmark.com, ebay.com".
        let resale: String?
        /// "Models: 501, 517, 527", when the retail price spans the likely models.
        let models: String?
        let found: Bool
    }

    /// The three prices, in whole dollars: list at (room for offers), realistic sale, fast sale.
    struct Prices: Equatable, Sendable {
        let listAt: String
        let realistic: String
        let fast: String
        /// Where they come from, as the seller reads it.
        let basedOn: String
    }

    struct Link: Equatable, Sendable {
        let label: String
        let url: URL
    }

    /// One line of the reality check: "You sold 3 like it on Depop: $25-$29".
    struct RealityLine: Equatable, Sendable {
        /// `KnownScanRealityKind`'s raw value.
        let kind: String
        let text: String
    }

    let scanID: String
    /// "Lululemon black high-rise leggings".
    let title: String
    /// "Size 6 · Nylon · Pre-owned good", whatever the AI could tell.
    let subtitle: String?
    /// How sure the read is of what the item is: "Sure of what it is".
    let readConfidence: String
    let call: Call
    /// The verdict, "Grab", "Maybe", "Leave" ("Checking prices" while they wait).
    let callLabel: String
    /// Under a Maybe: the seller decides.
    var verdictNote: String? {
        call == .yourCall ? "Your call" : nil
    }

    /// The verdict's one-line why: "Even its low end pays out $11 after fees, over your $8".
    let why: String?
    /// The prices wait for the web research or a comparison: the card says what it is only.
    let pricesPending: Bool
    /// The quiet progress line while they wait ("Checking prices: the web, Depop"), or what was
    /// checked once they are in.
    let pricingLabel: String?
    /// The sources the prices could not wait for or check: "Couldn't check the web in time".
    let missing: [String]
    /// What the prices rest on, in short plain lines; empty from a server without it.
    let realityCheck: [RealityLine]
    /// "High confidence".
    let confidence: String
    let basedOn: String
    /// The range the call rests on, "$25-$29", and what it pays out after fees.
    let range: String?
    /// List at, realistic sale, and fast sale, shown instead of the range when the server sends them.
    let prices: Prices?
    let payout: String?
    let ownSales: [OwnSales]
    /// The AI's estimate, "$24-$40", always shown with ``aiEstimateLabel``.
    let aiEstimate: String?
    let aiEstimateLabel: String?
    let flags: [String]
    let links: [Link]
    /// The AI could not read the brand, or was unsure: a tag close-up would help.
    let wantsTag: Bool
    /// The read named a brand, so the web can be asked about it.
    let hasBrand: Bool
    /// Asks the server for the prices: they wait, or a server that holds none has a brand to
    /// look up on the web.
    let needsPrices: Bool
    let signals: [Signal]
    /// The research, once it came in.
    let web: WebInfo?
    /// Each marketplace's comparisons, Depop first.
    var comparisons: [ScanComparisonLine]

    init(_ scan: ItemScan) {
        scanID = scan.id
        let identity = scan.identity
        let brand = identity.brand?.trimmingCharacters(in: .whitespaces) ?? ""
        let item = identity.item.trimmingCharacters(in: .whitespaces)
        let named = brand.isEmpty || item.lowercased().hasPrefix(brand.lowercased()) ? item : "\(brand) \(item)"
        title = named.prefix(1).uppercased() + named.dropFirst()
        subtitle = Self.subtitle(identity)
        readConfidence = Self.readConfidence(identity.confidence)
        let pending = scan.pricing?.status.value1 == .checking || scan.call.call.value1 == .checking
        call = switch scan.call.call.value1 {
        case .buy?: .buy
        case .yourCall?: .yourCall
        case .skip?: .skip
        case .checking?: .checking
        case nil: pending ? .checking : .other
        }
        callLabel = scan.call.label
        why = pending ? nil : scan.call.why
        pricesPending = pending
        pricingLabel = scan.pricing?.label
        missing = (scan.pricing?.missing ?? []).map(\.label)
        realityCheck = (scan.realityCheck ?? []).map { line in
            RealityLine(kind: line.kind.value1?.rawValue ?? line.kind.value2 ?? "", text: line.text)
        }
        confidence = switch scan.call.confidence.value1 {
        case .high?: "High confidence"
        case .medium?: "Medium confidence"
        case .low?, nil: "Low confidence"
        }
        basedOn = scan.call.basedOn
        range = Self.range(scan.call.low, scan.call.high)
        prices = scan.call.prices.map(Self.prices)
        payout = Self.payout(scan.call)
        ownSales = scan.ownSales.map(Self.ownSales)
        aiEstimate = scan.aiEstimate.flatMap { Self.range($0.low, $0.high) }
        aiEstimateLabel = scan.aiEstimate?.label
        flags = [
            scan.flags.visibleDamage ? "Visible damage" : nil,
            scan.flags.lotOrBundle ? "A lot or bundle" : nil,
            scan.flags.counterfeitProne ? "Often faked: check it's real" : nil,
        ].compactMap(\.self)
        links = scan.researchLinks.compactMap { link in URL(string: link.url).map { Link(label: link.label, url: $0) } }
        wantsTag = brand.isEmpty || identity.confidence < 0.6
        hasBrand = !brand.isEmpty
        needsPrices = pending || (scan.pricing == nil && !brand.isEmpty)
        signals = scan.call.signals.map(Self.signal)
        web = scan.research.map(Self.webInfo)
        comparisons = (scan.comparisons ?? []).map(Self.comparison)
    }

    static func prices(_ prices: Components.Schemas.ScanPrices) -> Prices {
        Prices(
            listAt: dollars(prices.listAt),
            realistic: dollars(prices.realisticSale),
            fast: dollars(prices.fastSale),
            basedOn: prices.basedOn,
        )
    }

    /// "You'd get about $22-$26 after Depop fees", or nil without both payouts.
    static func payout(_ call: Components.Schemas.ScanCall) -> String? {
        guard let low = call.conservativePayout, let high = call.optimisticPayout else { return nil }
        let marketplace = call.payoutMarketplace.map(marketplaceName) ?? ""
        let after = marketplace.isEmpty ? "after fees" : "after \(marketplace) fees"
        return "You'd get about \(range(low, high) ?? "") \(after)"
    }

    static func signal(_ signal: Components.Schemas.ScanSignal) -> Signal {
        Signal(
            kind: signal.kind.value1?.rawValue ?? signal.kind.value2 ?? "",
            label: signal.label,
            basedOn: signal.basedOn,
        )
    }

    static func comparison(_ row: Components.Schemas.ScanComparison) -> ScanComparisonLine {
        let status: ScanComparisonLine.Status = switch row.status.value1 {
        case .checking?: .checking
        case .read?: .read
        case .notEnough?, .paused?, .limit?, .failed?, nil: .unavailable
        }
        return ScanComparisonLine(
            marketplace: marketplaceName(row.marketplace),
            status: status,
            label: row.label,
            askingLabel: row.asking?.label,
            soldLabel: row.sold?.label,
            demand: row.demand?.label,
            demandBasedOn: row.demand?.basedOn,
        )
    }

    /// The signals the card lists on their own: asking prices and the demand show with their
    /// marketplace's comparison row instead, and the three prices (sent as a signal too, for
    /// builds before them) show in their own row.
    var listedSignals: [Signal] {
        let listed = signals.filter { ($0.kind != "prices" || prices == nil) && $0.kind != "missing" }
        return comparisons.isEmpty ? listed : listed.filter { $0.kind != "asking" && $0.kind != "demand" }
    }

    /// The card with a marketplace's read shown as not gone through (its answer never reached
    /// Listora), so it never says "Checking..." for one that will not come.
    func comparisonFailed(_ marketplace: String) -> ScanCard {
        var card = self
        let name = Self.marketplaceName(.init(value1: .init(rawValue: marketplace), value2: marketplace))
        card.comparisons = comparisons.map { row in
            guard row.marketplace == name, row.status == .checking else { return row }
            return ScanComparisonLine(
                marketplace: row.marketplace, status: .unavailable, label: "Couldn't check \(name)",
                askingLabel: nil, soldLabel: nil, demand: nil, demandBasedOn: nil,
            )
        }
        return card
    }

    /// What the seller feels when the card lands, so they can keep their eyes on the bin: two
    /// short taps for Buy, one long buzz for Skip, nothing for Your call.
    var haptic: Haptics.Event? {
        switch call {
        case .buy: .doubleTap
        case .skip: .longBuzz
        case .yourCall, .checking, .other: nil
        }
    }

    /// The verdict's tone: Grab green, Leave red, Maybe amber (the seller decides).
    var tone: StatusTone {
        switch call {
        case .buy: .success
        case .skip: .failed
        case .yourCall: .actionNeeded
        case .checking, .other: .neutral
        }
    }
}

/// One marketplace's comparisons: listings like it in its public search, read logged out.
/// Depop's are asking prices, always shown under their label; never sold prices. eBay's and
/// Mercari's are what close matches sold for, under theirs ("Sold listings on eBay").
struct ScanComparisonLine: Equatable, Sendable {
    enum Status: Equatable, Sendable {
        case checking
        case read
        /// Not enough similar listings, a pause, a used-up limit, or a read that failed.
        case unavailable
    }

    let marketplace: String
    let status: Status
    /// "Depop: asking $15-$25, 6 like it for sale", "eBay: sold $18-$30, 9 like it in the last
    /// 14 days", "Checking Depop...".
    let label: String
    /// "Asking prices - not sold listings", with numbers only.
    let askingLabel: String?
    /// "Sold listings on eBay", where the row's numbers are what close matches sold for.
    let soldLabel: String?
    /// "Sells for you, little competition", and what it rests on.
    let demand: String?
    let demandBasedOn: String?
}
