import Core
import Foundation
import OSLog
import WebKit

/// One marketplace's web views: the controller page that runs the bundle, and the marketplace
/// page its calls act on, kept between calls while the app is open.
@MainActor
final class RuntimeLane {
    let marketplace: String
    private(set) var controller: WKWebView?
    private var loaded: Task<Int, any Error>?
    private var controllerLoad: ControllerLoad?
    private let handle: @MainActor (WKScriptMessage) async -> (Any?, String?)
    /// The marketplace page: the one a call acts on now, or the warm one kept for the next.
    private(set) var currentPage: MarketplacePage?
    /// The session the page holds: what the phone kept when the page got it, or saved after.
    var session: [StoredCookie] = []
    /// A call runs on the page now.
    var calling = false

    init(marketplace: String, handle: @escaping @MainActor (WKScriptMessage) async -> (Any?, String?)) {
        self.marketplace = marketplace
        self.handle = handle
    }

    /// Loads the bundle into the controller page once; the runtime's version.
    func load(source: String?) async throws -> Int {
        if let loaded {
            return try await loaded.value
        }
        let task = Task<Int, any Error> { @MainActor in
            guard let source else {
                throw PhoneRuntimeError.bundleMissing
            }
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            let content = configuration.userContentController
            content.addUserScript(WKUserScript(
                source: source,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true,
                in: .page,
            ))
            content.addScriptMessageHandler(BridgeProxy(self), contentWorld: .page, name: "listora")
            let controller = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: configuration)
            WebViewShelf.shared.keep(controller, size: CGSize(width: 1, height: 1))
            self.controller = controller
            let finished = ControllerLoad()
            self.controllerLoad = finished
            controller.navigationDelegate = finished
            controller.loadHTMLString("<!doctype html><title>Listora</title>", baseURL: nil)
            try await finished.loaded.value(timeout: .seconds(20))
            let version = try await controller.evaluateJavaScript("listoraPhone.runtimeVersion")
            guard let number = version as? Int else {
                throw PhoneRuntimeError.bundleNotLoaded("the runtime has no version")
            }
            return number
        }
        loaded = task
        do {
            return try await task.value
        } catch {
            loaded = nil
            throw error
        }
    }

    /// The next call loads the runtime again, into a new controller page.
    func dropController() {
        controller?.removeFromSuperview()
        controller = nil
        controllerLoad = nil
        loaded = nil
    }

    /// A message from the runtime. Only the controller page's own main frame, Listora's blank
    /// page that runs the bundle, is answered; nothing else ever reaches the handler.
    fileprivate func received(_ message: WKScriptMessage) async -> (Any?, String?) {
        guard let controller, message.webView === controller, message.frameInfo.isMainFrame,
              Self.isRuntimePage(message.frameInfo.request.url)
        else {
            return (nil, "closed")
        }
        return await handle(message)
    }

    /// The blank page the runtime loads into (`about:blank`), never a page of the web.
    nonisolated static func isRuntimePage(_ url: URL?) -> Bool {
        guard let scheme = url?.scheme?.lowercased(), !scheme.isEmpty else { return true }
        return scheme == "about"
    }

    /// A web view for the marketplace, made before its first call, so the call finds it ready.
    func preparePage(logger: Logger) {
        if currentPage == nil {
            currentPage = MarketplacePage(origins: [], logger: logger)
        }
    }

    /// The page a call acts on: the warm one when it holds this session on these origins, else a
    /// new one with the session. `domains` are the marketplace's own (its cookie domains), which a
    /// check handed to the seller may go to.
    func page(
        origins: [String],
        domains: [String],
        session stored: [StoredCookie],
        logger: Logger,
    ) async -> MarketplacePage {
        if let page = currentPage, !page.handingOff {
            if page.origins.isEmpty, !page.hasSession {
                page.origins = Set(origins)
            }
            if page.origins == Set(origins), page.hasSession ? Self.same(stored, session) : true {
                if !page.hasSession {
                    await page.restore(stored)
                    session = stored
                }
                page.domains = domains
                return page
            }
        }
        closePage()
        let page = MarketplacePage(origins: origins, logger: logger)
        page.domains = domains
        await page.restore(stored)
        session = stored
        currentPage = page
        return page
    }

    func closePage() {
        currentPage?.close()
        currentPage = nil
        session = []
    }

    /// Whether two sessions are the same cookies (by name, domain, path, and value).
    static func same(_ one: [StoredCookie], _ other: [StoredCookie]) -> Bool {
        func key(_ cookie: StoredCookie) -> String {
            "\(cookie.domain)|\(cookie.path)|\(cookie.name)|\(cookie.value)"
        }
        return Set(one.map(key)) == Set(other.map(key))
    }
}

/// Holds the message handler weakly: the web view keeps its handler, which must not keep its
/// lane.
private final class BridgeProxy: NSObject, WKScriptMessageHandlerWithReply {
    weak var lane: RuntimeLane?

    init(_ lane: RuntimeLane) {
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

/// The controller page's one load, and its navigation policy: the blank page the runtime runs in
/// loads once, and the page never goes anywhere after it (a navigation the runtime or anything in
/// it starts is cancelled), so the `listora` handler only ever serves Listora's own page.
@MainActor
final class ControllerLoad: NSObject, WKNavigationDelegate {
    let loaded = OneShot<Void>()
    private var started = false

    func webView(_: WKWebView, decidePolicyFor _: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard !started, !loaded.isDone else { return .cancel }
        started = true
        return .allow
    }

    func webView(_: WKWebView, didFinish _: WKNavigation?) {
        loaded.finish(.success(()))
    }

    func webView(_: WKWebView, didFail _: WKNavigation?, withError error: any Error) {
        loaded.finish(.failure(error))
    }

    func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation?, withError error: any Error) {
        loaded.finish(.failure(error))
    }
}
