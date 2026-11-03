import Foundation

/// The thrift scan against the stub (docs/features/thrift-scan.md): Scan mode on, a run, and
/// every shot read into one invented scan with every part of the card filled, so the card is as
/// long as it gets. Invented data; no real shop's.
extension StubAPIServer {
    /// What `POST /v1/scans` answers.
    enum ScanAnswer: Sendable {
        /// Priced, with a long reality check: own sales, every marketplace's sold prices, asks,
        /// retail, the web, the brand pulse, and the sources it could not check.
        case fullRealityCheck
        /// From a server without the reality check: the call's long list of signals instead.
        case signalList
    }

    static let scanRunID = "0193a000-0000-7000-8000-00000000c0de"
    static let scanID = "0193a000-0000-7000-8000-00000000ca7d"
    /// The card's last line, which must be reachable inside the card.
    static let lastRealityLine = "Couldn't check Mercari in time"
    static let lastSignalLabel = "Unsold 2 like it"

    func respondToScans(method: String, path: String) -> Data? {
        switch (method, path) {
        case ("GET", "/v1/marketplace-features"):
            return Self.http(status: "200 OK", body: #"{"data":[],"app":{"features":["thrift_scan"]}}"#)
        case ("POST", "/v1/sourcing-runs"):
            let run = #"{"id":"\#(Self.scanRunID)","place":"Invented Thrift","startedAt":"2026-11-01T12:00:00Z","#
                + #""scanCount":0,"keptCount":0}"#
            return Self.http(status: "201 Created", body: run)
        case ("POST", "/v1/scans"):
            return Self.http(status: "201 Created", body: Self.scan(scanAnswer))
        case ("POST", "/v1/scans/\(Self.scanID)/research"):
            return Self.http(status: "200 OK", body: Self.scan(scanAnswer))
        default:
            return nil
        }
    }

    private static func usd(_ cents: Int) -> String {
        #"{"amountCents":\#(cents),"currency":"USD"}"#
    }

    private static func scan(_ answer: ScanAnswer) -> String {
        let identity = #"{"item":"waxed cotton field jacket with corduroy collar","brand":"Invented Outdoor Co","#
            + #""category":"clothing/outerwear/jackets","sizeLabel":"L","material":"waxed cotton","#
            + #""era":"vintage 1990s","condition":"pre_owned_good","confidence":0.92}"#
        let flags = #"{"visibleDamage":true,"lotOrBundle":true,"counterfeitProne":true}"#
        let ownSales = #"[{"marketplace":"depop","label":"Your sales of similar Invented Outdoor Co items on "#
            + #"Depop (last 365 days)","soldCount":4,"low":\#(usd(6200)),"median":\#(usd(7400)),"#
            + #""high":\#(usd(8800)),"displayOnly":false}]"#
        let links = #"[{"label":"Search Depop","url":"https://www.depop.com/search/?q=invented+field+jacket"}]"#
        let head = #"{"id":"\#(scanID)","runId":"\#(scanRunID)","createdAt":"2026-11-01T12:01:00Z","#
            + #""identity":\#(identity),"flags":\#(flags),"ownSales":\#(ownSales),"#
            + #""searchWords":"invented outdoor field jacket","researchLinks":\#(links),"decision":"undecided","#
        switch answer {
        case .fullRealityCheck:
            return head + #""call":\#(pricedCall),"pricing":\#(pricing),"realityCheck":\#(realityCheck)}"#
        case .signalList:
            return head + #""call":\#(signalCall)}"#
        }
    }

    private static let pricedCall = #"{"call":"buy","label":"Grab","#
        + #""why":"Even its fast sale pays out $48 after Depop fees, well over the $8 you want to clear, "#
        + #"and it sold four times for you this year","confidence":"high","basis":"own_history","#
        + #""basedOn":"Your 4 sales like it, eBay's, Poshmark's, and Mercari's sold prices, and the web's asks","#
        + #""low":\#(usd(6200)),"high":\#(usd(8800)),"conservativePayout":\#(usd(4800)),"#
        + #""optimisticPayout":\#(usd(7700)),"payoutMarketplace":"depop","worthListing":\#(usd(800)),"#
        + #""prices":{"listAt":\#(usd(9500)),"realisticSale":\#(usd(7400)),"fastSale":\#(usd(6000)),"#
        + #""basedOn":"Likely sale is the middle of your sales like it, fast sale their low end"},"signals":[]}"#

    private static let pricing = #"{"status":"ready","label":"Checked your sales, eBay, Poshmark, and the web.","#
        + #""missing":[{"source":"web","label":"Couldn't check the brand's own site in time"},"#
        + #"{"source":"mercari","label":"\#(lastRealityLine)"}]}"#

    private static let realityCheck: String = {
        let lines = [
            ("own_sales", "You sold 4 like it on Depop: $62-$88, most around $74"),
            ("market_sold", "eBay: 12 like it sold in the last 90 days, $55-$110, most around $78"),
            ("market_sold", "Poshmark: 7 like it sold lately, $60-$95, most around $72"),
            ("market_sold", "Mercari: 5 like it sold in the last 30 days, $48-$80"),
            ("asking", "Depop: 23 like it for sale now, asking $70-$140: asks, not sales"),
            ("retail", "Retail about $295 new (inventedoutdoor.example)"),
            ("web", "Listings on the web ask $80-$150 for this jacket in good shape: asks, not sales"),
            ("brand_pulse", "Invented Outdoor Co is in demand: waxed jackets are back, and vintage ones ask more"),
            ("missing", "Couldn't check the brand's own site in time"),
            ("missing", lastRealityLine),
        ]
        return "[" + lines.map { #"{"kind":"\#($0.0)","text":"\#($0.1)"}"# }.joined(separator: ",") + "]"
    }()

    private static let signalCall: String = {
        let signals = [
            ("retail", "Retail about $295", "Web info - not sold listings: inventedoutdoor.example's own price, new"),
            ("web_resale", "Asks $80-$150 on the web", "Web info - not sold listings: 9 listings on 4 sites"),
            ("brand_pulse", "In demand", "Web info - not sold listings: waxed jackets are back this season"),
            ("trend", "Searches up this month", "Web info - not sold listings: more searches than last month"),
            ("style", "Vintage 1990s cut", "The read: the collar and the cut date it to the 1990s"),
            ("new_with_tags", "No tags", "The read: worn, so it sells as pre-owned"),
            ("calibrated", "Scaled to your sales", "Your 4 sales like it sold below the web's asks"),
            ("unsold", lastSignalLabel, "2 like it went unsold on Depop for over 60 days"),
        ]
        let list = signals.map { #"{"kind":"\#($0.0)","label":"\#($0.1)","basedOn":"\#($0.2)"}"# }
            .joined(separator: ",")
        return #"{"call":"your_call","label":"Maybe","confidence":"medium","basis":"web_info","#
            + #""basedOn":"The web's asks, scaled to your sales","low":\#(usd(6000)),"high":\#(usd(9000)),"#
            + #""conservativePayout":\#(usd(4700)),"optimisticPayout":\#(usd(7800)),"payoutMarketplace":"depop","#
            + #""worthListing":\#(usd(800)),"signals":[\#(list)]}"#
    }()
}
