import Core
import Foundation
import OSLog
import WebKit

/// The marketplace page a phone run acts on: an off-screen web view with the seller's session
/// (a data store of its own, filled with the cookies this phone keeps), at a desktop size and
/// asking for desktop pages. It tells the runtime what only the app sees: when a page load
/// started and its document is ready, the main frame's HTTP status, and its dialogs.
///
/// The main frame may only load the marketplace's own origins (the server sends them), as on the
/// browser runner; a load anywhere else is refused (`blocked`). While the seller completes a
/// check in the visible browser (ChallengeHandOffView, which shows the page's address), the main
/// frame may also go to the marketplace's own domains and the sign-in providers a marketplace's
/// sign-in uses (`HandOffPolicy`), over https; never anywhere else, so a link or redirect on a
/// check page can't show another site's sign-in inside Listora.
@MainActor
final class MarketplacePage: NSObject {
    let webView: WKWebView
    /// The seller is completing a check in this page (`ChallengeHandOff`).
    var handingOff = false
    /// The marketplace's own origins, the only ones the main frame may load; empty (nothing
    /// loads) for a page made ahead of its first call, which sets them.
    var origins: Set<String>
    /// The marketplace's own domains (its cookie domains): a check handed to the seller may go to
    /// any page on them.
    var domains: [String] = []
    /// The page holds a session: the phone's cookies were restored into it.
    private(set) var hasSession = false
    private let logger: Logger
    private var status: Int?
    private var retryAfterSeconds: Int?
    private var acceptDialog = false
    /// Each page load's completion, by navigation, until WebKit ends the load, and the newest one.
    /// An entry keeps its navigation: an identifier is unique only while its object lives, and a
    /// freed navigation's identifier came back for a newer one, whose load then looked finished
    /// before it began, so the run read the page before it.
    private var loads: [ObjectIdentifier: (navigation: WKNavigation, load: OneShot<Void>)] = [:]
    private var newest: OneShot<Void>?

    init(origins: [String], logger: Logger) {
        self.origins = Set(origins)
        self.logger = logger
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.preferredContentMode = .desktop
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 1280, height: 900), configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        WebViewShelf.shared.keep(webView)
    }

    func restore(_ cookies: [StoredCookie]) async {
        let store = webView.configuration.websiteDataStore.httpCookieStore
        for cookie in cookies {
            if let cookie = cookie.httpCookie {
                await store.setCookie(cookie)
            }
        }
        hasSession = true
    }

    func cookies() async -> [StoredCookie] {
        await webView.configuration.websiteDataStore.httpCookieStore.allCookies().map(StoredCookie.init)
    }

    func close() {
        webView.stopLoading()
        if !handingOff {
            webView.removeFromSuperview()
        }
    }

    /// Between calls, while the page stays ready for the next: a blank page, so nothing of the
    /// marketplace's runs in the background; the session, the WebKit process, and its cache stay.
    func rest() {
        guard !handingOff else { return }
        webView.stopLoading()
        webView.loadHTMLString("", baseURL: nil)
    }

    /// Loads `url` in the main frame and waits for its document.
    func navigate(_ url: URL, timeout: Duration) async throws -> [String: Any] {
        status = nil
        retryAfterSeconds = nil
        guard let navigation = webView.load(URLRequest(url: url)) else { throw PageFailure("unreachable") }
        let load = track(navigation)
        try await load.value(timeout: timeout)
        return state()
    }

    /// Waits for a page load an action may have started to finish.
    func settle(timeout: Duration) async throws -> [String: Any] {
        try await Task.sleep(for: .milliseconds(150))
        if webView.isLoading, let newest {
            try await newest.value(timeout: timeout)
        }
        return state()
    }

    func state() -> [String: Any] {
        [
            "url": webView.url?.absoluteString ?? "about:blank",
            "status": status.map { $0 as Any } ?? NSNull(),
            "retryAfterSeconds": retryAfterSeconds.map { $0 as Any } ?? NSNull(),
        ]
    }

    /// Runs one of the runtime's page functions (`dom.ts`) in an isolated script world: the page's
    /// own scripts can't see or change it, and they share the page's elements and events.
    func evaluate(_ body: String, _ arguments: [String: Any], timeout: Duration) async throws -> Any {
        try await run(body, arguments, in: .defaultClient, timeout: timeout)
    }

    /// The page's own global `name`, serialized by the page as JSON (`null` when it has none).
    /// This one fixed read runs in the page's own script world, the only place a page's own data
    /// lives (Poshmark's script that embeds it removes itself once it ran).
    func pageData(_ name: String, timeout: Duration) async throws -> Any {
        try await run(
            "const value = globalThis[name]; return value === undefined ? null : JSON.stringify(value);",
            ["name": name],
            in: .page,
            timeout: timeout,
        )
    }

    private func run(
        _ body: String,
        _ arguments: [String: Any],
        in world: WKContentWorld,
        timeout: Duration,
    ) async throws -> Any {
        let result = OneShot<PageValue>()
        let webView = webView
        Task { @MainActor in
            do {
                let value = try await webView.callAsyncJavaScript(
                    body,
                    arguments: arguments,
                    in: nil,
                    contentWorld: world,
                )
                result.finish(.success(PageValue(value: value ?? NSNull())))
            } catch {
                result.finish(.failure(PageFailure(Self.message(of: error))))
            }
        }
        return try await result.value(timeout: timeout).value
    }

    func acceptNextDialog() {
        acceptDialog = true
    }

    private func track(_ navigation: WKNavigation) -> OneShot<Void> {
        let id = ObjectIdentifier(navigation)
        if let known = loads[id] {
            return known.load
        }
        let load = OneShot<Void>()
        loads[id] = (navigation, load)
        newest = load
        return load
    }

    /// A load WebKit ended (it finished or failed): nothing more comes for it, so it is let go.
    private func end(_ navigation: WKNavigation) -> OneShot<Void> {
        let load = track(navigation)
        loads[ObjectIdentifier(navigation)] = nil
        return load
    }

    /// A page function's own failure (`element_timeout: ...`), or the reason the page is gone.
    private static func message(of error: any Error) -> String {
        let error = error as NSError
        let message = error.userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription
        return message.hasPrefix("Error: ") ? String(message.dropFirst(7)) : message
    }

    /// Resolves the load once its document is ready: Playwright's `domcontentloaded`, which the
    /// runner's scripts wait for, comes before WebKit's `didFinish` (every image and script).
    private func whenReady(_ load: OneShot<Void>) {
        Task { @MainActor [weak self] in
            for _ in 0 ..< 600 {
                guard let self, !load.isDone else { return }
                let ready = try? await webView.evaluateJavaScript("document.readyState") as? String
                if ready == "interactive" || ready == "complete" {
                    load.finish(.success(()))
                    return
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
    }
}

extension MarketplacePage: WKNavigationDelegate {
    func webView(
        _: WKWebView,
        decidePolicyFor action: WKNavigationAction,
    ) async -> WKNavigationActionPolicy {
        let url = action.request.url
        let scheme = url?.scheme?.lowercased()
        guard scheme == "https" || scheme == "http" || scheme == "about" || scheme == "blob" else {
            return .cancel
        }
        // Frames load freely (a marketplace's checks come in frames, which the run must see).
        guard action.targetFrame?.isMainFrame ?? true, scheme != "about" else {
            return .allow
        }
        guard let url, let origin = url.webOrigin else { return .cancel }
        if origins.contains(origin) || (handingOff && HandOffPolicy.allows(url, domains: domains)) {
            return .allow
        }
        logger.info("refused a page outside the marketplace")
        return .cancel
    }

    func webView(
        _: WKWebView,
        decidePolicyFor response: WKNavigationResponse,
    ) async -> WKNavigationResponsePolicy {
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse {
            status = http.statusCode
            retryAfterSeconds = (http.value(forHTTPHeaderField: "Retry-After")).flatMap(Int.init)
        }
        return .allow
    }

    func webView(_: WKWebView, didStartProvisionalNavigation navigation: WKNavigation?) {
        if let navigation {
            _ = track(navigation)
        }
    }

    func webView(_: WKWebView, didCommit navigation: WKNavigation?) {
        guard let navigation else { return }
        whenReady(track(navigation))
    }

    func webView(_: WKWebView, didFinish navigation: WKNavigation?) {
        guard let navigation else { return }
        end(navigation).finish(.success(()))
    }

    func webView(_: WKWebView, didFail navigation: WKNavigation?, withError error: any Error) {
        fail(navigation, error)
    }

    func webView(
        _: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation?,
        withError error: any Error,
    ) {
        fail(navigation, error)
    }

    private func fail(_ navigation: WKNavigation?, _ error: any Error) {
        guard let navigation else { return }
        let load = end(navigation)
        let error = error as NSError
        // A load another one replaced: the newer one decides.
        if error.domain == NSURLErrorDomain, error.code == NSURLErrorCancelled, newest !== load {
            load.finish(.success(()))
            return
        }
        // WebKit's "frame load interrupted": a page the policy above refused.
        let refused = error.domain == WKError.errorDomain && error.code == 102
        load.finish(.failure(PageFailure(refused ? "blocked" : "unreachable")))
    }
}

extension MarketplacePage: WKUIDelegate {
    func webView(
        _: WKWebView,
        runJavaScriptConfirmPanelWithMessage _: String,
        initiatedByFrame _: WKFrameInfo,
    ) async -> Bool {
        let accept = acceptDialog
        acceptDialog = false
        return accept
    }

    func webView(
        _: WKWebView,
        runJavaScriptAlertPanelWithMessage _: String,
        initiatedByFrame _: WKFrameInfo,
    ) async {}

    func webView(
        _: WKWebView,
        runJavaScriptTextInputPanelWithPrompt _: String,
        defaultText _: String?,
        initiatedByFrame _: WKFrameInfo,
    ) async -> String? {
        nil
    }

    /// Scripts work in one page: a window the site opens is not opened.
    func webView(
        _: WKWebView,
        createWebViewWith _: WKWebViewConfiguration,
        for _: WKNavigationAction,
        windowFeatures _: WKWindowFeatures,
    ) -> WKWebView? {
        nil
    }
}

/// A page function's result: JSON values, which only the main actor ever reads.
struct PageValue: @unchecked Sendable {
    let value: Any
}

/// A result that comes once: the first `finish` wins, and every wait, before or after, gets it.
/// A wait that runs out of time fails with `timeout` without finishing it.
@MainActor
final class OneShot<Value: Sendable> {
    private var result: Result<Value, any Error>?
    private var waiters: [UUID: CheckedContinuation<Value, any Error>] = [:]

    var isDone: Bool {
        result != nil
    }

    func finish(_ result: Result<Value, any Error>) {
        guard self.result == nil else { return }
        self.result = result
        let waiting = waiters
        waiters = [:]
        for continuation in waiting.values {
            continuation.resume(with: result)
        }
    }

    func value(timeout: Duration) async throws -> Value {
        if let result {
            return try result.get()
        }
        let id = UUID()
        let timer = Task { @MainActor [weak self] in
            try? await Task.sleep(for: timeout)
            guard !Task.isCancelled, let self, let continuation = waiters.removeValue(forKey: id) else { return }
            continuation.resume(throwing: PageFailure("timeout"))
        }
        defer { timer.cancel() }
        return try await withCheckedThrowingContinuation { continuation in
            waiters[id] = continuation
        }
    }
}

/// Where the main frame of a check handed to the seller may go, besides the marketplace's own
/// origins: its own domains, and the sign-in providers marketplaces offer ("Continue with
/// Google"), over https only.
enum HandOffPolicy {
    static let signInProviders: Set = [
        "accounts.google.com",
        "appleid.apple.com",
        "www.facebook.com",
        "m.facebook.com",
    ]

    static func allows(_ url: URL, domains: [String]) -> Bool {
        guard url.scheme?.lowercased() == "https", let host = url.host()?.lowercased(), !host.isEmpty else {
            return false
        }
        return signInProviders.contains(host)
            || domains.contains { host == $0.lowercased() || host.hasSuffix(".\($0.lowercased())") }
    }
}
