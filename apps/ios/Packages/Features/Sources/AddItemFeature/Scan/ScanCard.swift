import DesignSystem
import Foundation
import ListoraAPI

/// A scan's answer as its card shows it (docs/features/thrift-scan.md): what the item is, the
/// call with its confidence and what it rests on, the household's own sales like it, and the AI
/// estimate under its label. Every price is a range with its source, in whole dollars; "sold"
/// is only ever the server's words next to the household's own sales.
struct ScanCard: Equatable, Sendable {
    enum Call: Equatable, Sendable {
        case buy
        case yourCall
        case skip
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

    struct Link: Equatable, Sendable {
        let label: String
        let url: URL
    }

    let scanID: String
    /// "Lululemon black high-rise leggings".
    let title: String
    /// "Size 6 · Pre-owned good", whatever the AI could tell.
    let subtitle: String?
    let call: Call
    let callLabel: String
    /// "High confidence".
    let confidence: String
    let basedOn: String
    /// The range the call rests on, "$25-$29", and what it pays out after fees.
    let range: String?
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
        let details = [
            identity.sizeLabel.map { "Size \($0)" },
            identity.condition.map(Self.conditionName),
        ].compactMap(\.self)
        subtitle = details.isEmpty ? nil : details.joined(separator: " · ")
        call = switch scan.call.call.value1 {
        case .buy?: .buy
        case .yourCall?: .yourCall
        case .skip?: .skip
        case nil: .other
        }
        callLabel = scan.call.label
        confidence = switch scan.call.confidence.value1 {
        case .high?: "High confidence"
        case .medium?: "Medium confidence"
        case .low?, nil: "Low confidence"
        }
        basedOn = scan.call.basedOn
        range = Self.range(scan.call.low, scan.call.high)
        if let low = scan.call.conservativePayout, let high = scan.call.optimisticPayout {
            let marketplace = scan.call.payoutMarketplace.map(Self.marketplaceName) ?? ""
            let after = marketplace.isEmpty ? "after fees" : "after \(marketplace) fees"
            payout = "You'd get about \(Self.range(low, high) ?? "") \(after)"
        } else {
            payout = nil
        }
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
        signals = scan.call.signals.map(Self.signal)
        web = scan.research.map(Self.webInfo)
        comparisons = (scan.comparisons ?? []).map(Self.comparison)
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
            demand: row.demand?.label,
            demandBasedOn: row.demand?.basedOn,
        )
    }

    /// The signals the card lists on their own: asking prices and the demand show with their
    /// marketplace's comparison row instead.
    var listedSignals: [Signal] {
        comparisons.isEmpty ? signals : signals.filter { $0.kind != "asking" && $0.kind != "demand" }
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
                askingLabel: nil, demand: nil, demandBasedOn: nil,
            )
        }
        return card
    }

    static func webInfo(_ research: Components.Schemas.ScanResearch) -> WebInfo {
        let resale = research.resale.map { resale in
            let sites = resale.sources.map(\.site).joined(separator: ", ")
            return "Asks \(range(resale.low, resale.high) ?? "") on \(sites)"
        }
        let models = research.retail.flatMap { retail in
            retail.models.count > 1 ? "Models: " + retail.models.joined(separator: ", ") : nil
        }
        return WebInfo(
            label: research.label,
            summary: research.summary,
            resale: resale,
            models: models,
            found: research.status.value1 == .found,
        )
    }

    /// What the seller feels when the card lands, so they can keep their eyes on the bin: two
    /// short taps for Buy, one long buzz for Skip, nothing for Your call.
    var haptic: Haptics.Event? {
        switch call {
        case .buy: .doubleTap
        case .skip: .longBuzz
        case .yourCall, .other: nil
        }
    }

    /// The call's tone: Buy confirmed-green, Skip red, Your call amber (the seller decides).
    var tone: StatusTone {
        switch call {
        case .buy: .success
        case .skip: .failed
        case .yourCall: .actionNeeded
        case .other: .neutral
        }
    }

    /// "3 sold · $25-$29 · median $28" on one marketplace.
    static func ownSales(_ line: Components.Schemas.ScanOwnSales) -> OwnSales {
        let count = line.soldCount == 1 ? "1 sold" : "\(line.soldCount) sold"
        return OwnSales(
            marketplace: marketplaceName(line.marketplace),
            label: line.label,
            summary: [count, range(line.low, line.high), "median \(dollars(line.median))"]
                .compactMap(\.self)
                .joined(separator: " · "),
            displayOnly: line.displayOnly,
        )
    }

    static func dollars(_ money: Components.Schemas.Money) -> String {
        (Decimal(money.amountCents) / 100)
            .formatted(.currency(code: money.currency.rawValue).precision(.fractionLength(0)))
    }

    /// "$25-$29", or one amount when both ends round to it; nil without both.
    static func range(_ low: Components.Schemas.Money?, _ high: Components.Schemas.Money?) -> String? {
        guard let low, let high else { return nil }
        let lowText = dollars(low)
        let highText = dollars(high)
        return lowText == highText ? lowText : "\(lowText)-\(highText)"
    }

    static func marketplaceName(_ marketplace: Components.Schemas.Marketplace) -> String {
        switch marketplace.value1 {
        case .ebay?: "eBay"
        case .depop?: "Depop"
        case .poshmark?: "Poshmark"
        case .mercari?: "Mercari"
        case nil: marketplace.value2 ?? ""
        }
    }

    static func conditionName(_ condition: Components.Schemas.ItemCondition) -> String {
        switch condition {
        case .newWithTags: "New with tags"
        case .newWithoutTags: "New without tags"
        case .newWithDefects: "New with defects"
        case .preOwnedExcellent: "Pre-owned excellent"
        case .preOwnedGood: "Pre-owned good"
        case .preOwnedFair: "Pre-owned fair"
        }
    }
}

/// One marketplace's comparisons: listings like it in its public search, read logged out.
/// Depop's are asking prices, always shown under their label; never sold prices.
struct ScanComparisonLine: Equatable, Sendable {
    enum Status: Equatable, Sendable {
        case checking
        case read
        /// Not enough similar listings, a pause, a used-up limit, or a read that failed.
        case unavailable
    }

    let marketplace: String
    let status: Status
    /// "Depop: asking $15-$25, 6 like it for sale", "Checking Depop...".
    let label: String
    /// "Asking prices - not sold listings", with numbers only.
    let askingLabel: String?
    /// "Sells for you, little competition", and what it rests on.
    let demand: String?
    let demandBasedOn: String?
}
