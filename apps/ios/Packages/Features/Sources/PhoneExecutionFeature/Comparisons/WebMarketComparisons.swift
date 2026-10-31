import Core
import Foundation
import OSLog
import WebKit

/// The comparison lane (docs/features/thrift-scan.md, "Marketplace comparisons") in the app's own
/// web views: per marketplace, a hidden controller page running the phone runtime's bundle
/// (`listoraPhone.compare`), and a marketplace page that holds **no account**: its own
/// non-persistent data store, never given the seller's cookies, never the page the seller's own
/// automation runs in, and never handed to the seller (a check ends the read; Listora never
/// passes one). Images, fonts, and media are blocked, so a read moves only its data.
///
/// While a run is on, each marketplace's page stays warm (its search page loaded); `coolDown`
/// lets them go. A marketplace that showed a check is not read again on this iPhone for 24 hours
/// (`ComparisonPauses`), whatever the server asks.
@MainActor
public final class WebMarketComparisons: MarketComparisons {
    private let source: @MainActor () -> String?
    private let pauses: ComparisonPauses
    private let logger = Logger(subsystem: "com.listora.app", category: "comparisons")
    private var lanes: [String: ComparisonLane] = [:]
    private var rules: WKContentRuleList?
    private var rulesLoaded = false

    /// `source` is the phone runtime's script (the server's, or the app's own).
    public init(source: @escaping @MainActor () -> String?, pauses: ComparisonPauses = ComparisonPauses()) {
        self.source = source
        self.pauses = pauses
    }

    public func warmUp(_ marketplaces: [String]) {
        for marketplace in marketplaces where !pauses.isPaused(marketplace) {
            Task {
                let lane = await lane(for: marketplace)
                let answer = await lane.call("warmUp", input: ComparisonLane.warmUpInput(marketplace))
                if let answer, Self.outcome(of: answer) == "check" {
                    pauses.pause(marketplace)
                }
            }
        }
    }

    public func compare(_ input: Data, marketplace: String) async -> Data? {
        if pauses.isPaused(marketplace) {
            return try? JSONSerialization.data(withJSONObject: [
                "outcome": "check",
                "message": "this iPhone met a check on this marketplace in the last day",
                "ms": 0,
            ])
        }
        guard let object = try? JSONSerialization.jsonObject(with: input) as? [String: Any] else { return nil }
        let lane = await lane(for: marketplace)
        guard let answer = await lane.call("compare", input: object) else { return nil }
        switch Self.outcome(of: answer) {
        case "check":
            pauses.pause(marketplace)
        case "rate_limited":
            pauses.pause(marketplace, for: .seconds(60 * 60))
        default:
            break
        }
        return try? JSONSerialization.data(withJSONObject: answer)
    }

    public func coolDown() {
        for lane in lanes.values {
            lane.close()
        }
        lanes = [:]
    }

    private func lane(for marketplace: String) async -> ComparisonLane {
        if let lane = lanes[marketplace] {
            return lane
        }
        let rules = await contentRules()
        if let lane = lanes[marketplace] {
            return lane
        }
        let lane = ComparisonLane(marketplace: marketplace, source: source, rules: rules, logger: logger)
        lanes[marketplace] = lane
        return lane
    }

    /// The rules that keep images, fonts, and media from loading in the comparison pages.
    private func contentRules() async -> WKContentRuleList? {
        if rulesLoaded {
            return rules
        }
        rulesLoaded = true
        rules = try? await WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "listora-comparisons",
            encodedContentRuleList: Self.blockedMedia,
        )
        return rules
    }

    static let blockedMedia = """
    [{"trigger":{"url-filter":".*","resource-type":["image","font","media"]},"action":{"type":"block"}}]
    """

    static func outcome(of answer: [String: Any]) -> String? {
        answer["outcome"] as? String
    }
}

/// When a marketplace's comparisons wait on this iPhone after a check (24 hours) or a request to
/// slow down (an hour), kept across launches.
@MainActor
public struct ComparisonPauses {
    private let defaults: UserDefaults
    private let now: () -> Date
    static let key = "comparisons.pausedUntil"

    public init(defaults: UserDefaults = .standard, now: @escaping () -> Date = Date.init) {
        self.defaults = defaults
        self.now = now
    }

    public func isPaused(_ marketplace: String) -> Bool {
        guard let until = until()[marketplace] else { return false }
        return until > now().timeIntervalSince1970
    }

    public func pause(_ marketplace: String, for duration: Duration = .seconds(24 * 60 * 60)) {
        var all = until()
        all[marketplace] = now().timeIntervalSince1970 + Double(duration.components.seconds)
        defaults.set(all, forKey: Self.key)
    }

    private func until() -> [String: Double] {
        defaults.dictionary(forKey: Self.key) as? [String: Double] ?? [:]
    }
}

/// One marketplace's comparison web views: the controller page that runs the bundle and the
/// logged-out marketplace page its reads act on.
@MainActor
final class ComparisonLane {
    let marketplace: String
    private let source: @MainActor () -> String?
    private let rules: WKContentRuleList?
    private let logger: Logger
    private var controller: WKWebView?
    private var controllerLoad: ControllerLoad?
    private var loaded: Task<Void, any Error>?
    private(set) var page: MarketplacePage?
    /// The call before this one: calls run one at a time, in order, on the one page.
    private var previous: Task<Void, Never>?

    init(
        marketplace: String,
        source: @escaping @MainActor () -> String?,
        rules: WKContentRuleList?,
        logger: Logger,
    ) {
        self.marketplace = marketplace
        self.source = source
        self.rules = rules
        self.logger = logger
    }

    /// The marketplace's own origins, the only ones its comparison page loads.
    static let origins: [String: [String]] = [
        "depop": ["https://www.depop.com", "https://depop.com"],
    ]

    /// A warm-up names only the marketplace: the runtime paces it as the marketplace's reads.
    static func warmUpInput(_ marketplace: String) -> [String: Any] {
        ["marketplace": marketplace]
    }

    /// Runs `listoraPhone.<method>(input)` once the calls before it ended (the seller may shoot
    /// the next item while the last one is read); nil when the runtime can't (an older bundle
    /// without the lane, or web views that failed).
    func call(_ method: String, input: [String: Any]) async -> [String: Any]? {
        // The input and the answer cross the turn as JSON, which is Sendable.
        guard let sent = try? JSONSerialization.data(withJSONObject: input) else { return nil }
        let before = previous
        let turn = Task<Data?, Never> { @MainActor in
            await before?.value
            guard let input = (try? JSONSerialization.jsonObject(with: sent)) as? [String: Any],
                  let answer = await self.run(method, input: input)
            else { return nil }
            return try? JSONSerialization.data(withJSONObject: answer)
        }
        previous = Task { _ = await turn.value }
        guard let answer = await turn.value else { return nil }
        return (try? JSONSerialization.jsonObject(with: answer)) as? [String: Any]
    }

    private func run(_ method: String, input: [String: Any]) async -> [String: Any]? {
        do {
            try await load()
            guard let controller else { return nil }
            if page == nil {
                // Never restored with any cookie: the page holds no account.
                page = MarketplacePage(origins: Self.origins[marketplace] ?? [], logger: logger, contentRules: rules)
            }
            let has = try await controller.evaluateJavaScript("typeof listoraPhone.\(method) === 'function'")
            guard has as? Bool == true else { return nil }
            let result = try await controller.callAsyncJavaScript(
                "return await listoraPhone.\(method)(input);",
                arguments: ["input": input],
                in: nil,
                contentWorld: .page,
            )
            return result as? [String: Any]
        } catch {
            logger.error("Comparison read failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    func close() {
        page?.close()
        page = nil
        controller?.removeFromSuperview()
        controller = nil
        controllerLoad = nil
        loaded = nil
    }

    private func load() async throws {
        if let loaded {
            return try await loaded.value
        }
        let task = Task<Void, any Error> { @MainActor in
            guard let source = source() else { throw PhoneRuntimeError.bundleMissing }
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            let content = configuration.userContentController
            content.addUserScript(
                WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page),
            )
            content.addScriptMessageHandler(ComparisonBridge(self), contentWorld: .page, name: "listora")
            let controller = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: configuration)
            WebViewShelf.shared.keep(controller, size: CGSize(width: 1, height: 1))
            self.controller = controller
            let finished = ControllerLoad()
            controllerLoad = finished
            controller.navigationDelegate = finished
            controller.loadHTMLString("<!doctype html><title>Listora</title>", baseURL: nil)
            try await finished.loaded.value(timeout: .seconds(20))
        }
        loaded = task
        do {
            try await task.value
        } catch {
            loaded = nil
            throw error
        }
    }

    /// A message from the runtime: only the controller page's own main frame is answered.
    fileprivate func received(_ message: WKScriptMessage) async -> (Any?, String?) {
        guard let controller, message.webView === controller, message.frameInfo.isMainFrame,
              RuntimeLane.isRuntimePage(message.frameInfo.request.url)
        else {
            return (nil, "closed")
        }
        guard let body = message.body as? [String: Any], let method = body["method"] as? String else {
            return (nil, "the message has no method")
        }
        let args = body["args"] as? [String: Any] ?? [:]
        let timeout = Duration.milliseconds((args["timeoutMs"] as? NSNumber)?.intValue ?? 30000)
        if method == "log" || method == "progress" {
            return (true, nil)
        }
        guard let page else { return (nil, "closed") }
        do {
            return try await (relay(method, args, on: page, timeout: timeout), nil)
        } catch let failure as PageFailure {
            return (nil, failure.message)
        } catch {
            return (nil, error.localizedDescription)
        }
    }

    /// Does what the runtime asked of the logged-out page; throws `PageFailure` in its words.
    private func relay(
        _ method: String,
        _ args: [String: Any],
        on page: MarketplacePage,
        timeout: Duration,
    ) async throws -> Any {
        switch method {
        case "navigate":
            guard let url = (args["url"] as? String).flatMap(URL.init(string:)) else { throw PageFailure("blocked") }
            return try await page.navigate(url, timeout: timeout)
        case "settle":
            return try await page.settle(timeout: timeout)
        case "state":
            return page.state()
        case "evaluate":
            let script = args["body"] as? String ?? ""
            return try await page.evaluate(script, args["args"] as? [String: Any] ?? [:], timeout: timeout)
        case "pageData":
            return try await page.pageData(args["name"] as? String ?? "", timeout: timeout)
        case "acceptNextDialog":
            page.acceptNextDialog()
            return true
        case "handOff":
            // No seller session is involved, so there is nothing of theirs to unblock.
            return "unavailable"
        default:
            // Photos and anything else: a comparison read fetches nothing of Listora's.
            throw PageFailure("blocked")
        }
    }
}

/// Holds the message handler weakly, as the runtime's own bridge does.
private final class ComparisonBridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var lane: ComparisonLane?

    init(_ lane: ComparisonLane) {
        self.lane = lane
    }

    @MainActor
    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
    ) async -> (Any?, String?) {
        guard let lane else { return (nil, "closed") }
        return await lane.received(message)
    }
}
