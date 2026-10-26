/// The stub API's marketplace connections, in the words the server uses.
extension StubAPIServer {
    /// The Marketplaces screen before eBay is connected: the health summary, nothing needing
    /// attention (`packages/connections/src/health-summary.ts`).
    static let connectionHealth = #"{"needsAttention":false,"attention":[],"#
        + #""connections":\#(connections),"saleForwarding":{"status":"needs_domain","statusDisplay":"#
        + #"{"tone":"neutral","label":"Set up when you add a domain","detail":"Forwarding your "#
        + #"marketplaces' sale emails to Listora lets it spot sales sooner. It needs Listora's email "#
        + #"domain, which isn't set up yet."}}}"#

    /// Every marketplace's connection before eBay is connected, as a JSON array, in the words the
    /// server uses (`packages/connections/src/status-display.ts`).
    static func capabilities(_ mode: String, connect: String) -> String {
        let verify = mode == "api" ? "api" : "user_confirm"
        return #"{"connect":"\#(connect)","create":"\#(mode)","updatePrice":"\#(mode)","#
            + #""updateDetails":"\#(mode)","delist":"\#(mode)","relist":"\#(mode)","markSold":"\#(mode)","#
            + #""verifyRead":"\#(verify)","importListings":"none","saleDetection":["manual"],"#
            + #""imageTransport":"url_fetch"}"#
    }

    /// A marketplace Listora works with in assisted mode, with no account linked.
    static func assistedConnection(_ id: String, _ name: String) -> String {
        #"{"marketplace":"\#(id)","mode":"assisted","status":"not_connected","#
            + #""statusDisplay":{"tone":"neutral","label":"Not linked","detail":"Listora works with "#
            + #"\#(name) in assisted mode: it prepares each listing and change, and you finish it in the "#
            + #"\#(name) app, then confirm it."},"#
            + #""capabilities":\#(capabilities("assisted", connect: "none")),"availableActions":[]}"#
    }

    static let connections: String = {
        let ebay = #"{"marketplace":"ebay","mode":"api","status":"not_connected","#
            + #""statusDisplay":{"tone":"neutral","label":"Not connected","detail":"Connect your eBay "#
            + #"account so Listora can list, update, and end your items there, and confirm every change "#
            + #"with eBay."},"capabilities":\#(StubAPIServer.capabilities("api", connect: "oauth")),"#
            + #""availableActions":["connect"]}"#
        let assisted = [("depop", "Depop"), ("poshmark", "Poshmark"), ("mercari", "Mercari")]
        let all = [ebay] + assisted.map { StubAPIServer.assistedConnection($0.0, $0.1) }
        return "[\(all.joined(separator: ","))]"
    }()

    /// Depop's connection while its sign-in is checked again.
    static let depopConnectionChecking = #"{"marketplace":"depop","mode":"automation","#
        + #""status":"connected","statusDisplay":{"tone":"checking","label":"Checking..."},"#
        + #""capabilities":{"connect":"none","create":"automation","updatePrice":"automation","#
        + #""updateDetails":"automation","delist":"automation","relist":"automation","#
        + #""markSold":"automation","verifyRead":"automation","importListings":"none","#
        + #""saleDetection":["poll"],"imageTransport":"upload"},"availableActions":[]}"#
}
