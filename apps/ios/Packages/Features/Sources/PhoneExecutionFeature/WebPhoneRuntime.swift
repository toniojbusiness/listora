import Core
import Foundation
import OSLog
import UIKit
import WebKit

/// Runs one script call of the phone runtime (`phone-runtime.js`, built from the server's own
/// automation code; docs/features/phone-execution.md).
@MainActor
public protocol PhoneRuntime: AnyObject {
    /// The version of calls the bundled runtime speaks; the server hands it only those.
    func runtimeVersion() async throws -> Int
    /// Runs the call (`PhoneCall.input`, JSON) in the marketplace's session on this phone and
    /// returns what the runtime answered (`PhoneCallOutput`, JSON).
    func run(_ input: Data, marketplace: String) async throws -> Data
    /// Takes the runtime the server runs with when it changed, so the phone runs the scripts the
    /// server replays its answers through; call it between runs.
    func refresh() async
    /// Tells `handler` each step a call starts, as the runtime reports it.
    func observeSteps(_ handler: @escaping @MainActor (PhoneStep) -> Void)
}

extension PhoneRuntime {
    public func refresh() async {}
    public func observeSteps(_: @escaping @MainActor (PhoneStep) -> Void) {}
}

/// The runtime as the server hands it out (`getPhoneRuntime`): its digest, and its script when
/// it is not the one the app already runs.
public struct RemoteRuntime: Sendable {
    public let digest: String
    public let source: String?

    public init(digest: String, source: String?) {
        self.digest = digest
        self.source = source
    }
}

/// What a check the run stopped at needs from the seller: the page, shown in a visible in-app
/// browser, until they complete the check themselves or decline.
@MainActor
public protocol ChallengeHandOff: AnyObject {
    /// `completed`, `declined`, or `unavailable` (nobody to ask: the app is in the background).
    func handOff(_ page: WKWebView, check: String, marketplace: String) async -> String
}

public enum PhoneRuntimeError: Error, Equatable {
    case bundleMissing
    case bundleNotLoaded(String)
    case invalidAnswer
}

/// The phone runtime in the app's own web views. A hidden controller page runs the bundle; it
/// reaches the marketplace page, an off-screen web view holding the seller's session (the
/// cookies this phone keeps), through the `listora` message handler, whose every message is
/// answered. The app only relays: it loads pages, evaluates the runtime's page functions, reads
/// the page's own data, reports the main frame's navigations, answers dialogs, fetches listing
/// photos, and hands a check to the seller. Every rule stays in the runtime.
///
/// The marketplace page asks for desktop pages at a desktop size, as Safari's "Request Desktop
/// Website" does, so the marketplaces serve the same pages the browser runner's scripts read.
/// It is WebKit, as it says; nothing disguises it.
@MainActor
public final class WebPhoneRuntime: NSObject, PhoneRuntime {
    private let sessions: any MarketplaceSessionStore
    private weak var handOff: (any ChallengeHandOff)?
    private let notifier: CheckNeededNotifier
    private let logger = Logger(subsystem: "com.listora.app", category: "phone-runtime")
    private var controller: WKWebView?
    private var controllerLoad: ControllerLoad?
    private var loaded: Task<Int, any Error>?
    private var page: MarketplacePage?
    /// The server's runtime, once it handed one out; the app's own copy runs until then.
    private var served: (digest: String, source: String)?
    private let fetchRuntime: @Sendable (_ have: String?) async -> RemoteRuntime?
    private var stepStarted: (@MainActor (PhoneStep) -> Void)?

    public init(
        sessions: any MarketplaceSessionStore,
        handOff: (any ChallengeHandOff)?,
        notifier: CheckNeededNotifier = CheckNeededNotifier(),
        fetchRuntime: @escaping @Sendable (_ have: String?) async -> RemoteRuntime? = { _ in nil },
    ) {
        self.sessions = sessions
        self.handOff = handOff
        self.notifier = notifier
        self.fetchRuntime = fetchRuntime
    }

    public func observeSteps(_ handler: @escaping @MainActor (PhoneStep) -> Void) {
        stepStarted = handler
    }

    public func refresh() async {
        guard let remote = await fetchRuntime(served?.digest), remote.digest != served?.digest,
              let source = remote.source
        else { return }
        served = (remote.digest, source)
        // The next run loads it into a new controller page.
        controller = nil
        controllerLoad = nil
        loaded = nil
    }

    public func runtimeVersion() async throws -> Int {
        try await load()
    }

    public func run(_ input: Data, marketplace: String) async throws -> Data {
        _ = try await load()
        guard let controller else { throw PhoneRuntimeError.bundleNotLoaded("no controller page") }
        let object = try JSONSerialization.jsonObject(with: input)
        let domains = ((object as? [String: Any])?["cookieDomains"] as? [String]) ?? []
        let origins = ((object as? [String: Any])?["origins"] as? [String]) ?? []
        let page = MarketplacePage(origins: origins, logger: logger)
        await page.restore(sessions.cookies(for: marketplace).filter { $0.belongs(to: domains) })
        self.page = page
        defer {
            self.page = nil
            page.close()
        }
        let result = try await controller.callAsyncJavaScript(
            "return await listoraPhone.run(input);",
            arguments: ["input": object],
            in: nil,
            contentWorld: .page,
        )
        // The cookies the marketplace refreshed are the session from now on.
        let refreshed = await page.cookies().filter { $0.belongs(to: domains) }
        if !refreshed.isEmpty {
            sessions.save(refreshed, for: marketplace)
        }
        guard let result, JSONSerialization.isValidJSONObject(result) else {
            throw PhoneRuntimeError.invalidAnswer
        }
        return try JSONSerialization.data(withJSONObject: result)
    }

    /// Loads the bundle into the controller page once; the runtime's version.
    private func load() async throws -> Int {
        if let loaded {
            return try await loaded.value
        }
        let served = served?.source
        let task = Task<Int, any Error> { @MainActor in
            guard let source = served ?? Self.bundledSource() else {
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

    /// The runtime the app was built with, which runs until the server hands out its own.
    private static func bundledSource() -> String? {
        guard let url = Bundle.module.url(forResource: "phone-runtime", withExtension: "js") else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    /// One message from the runtime; the reply is its answer, or the failure's message.
    fileprivate func handle(_ message: WKScriptMessage) async -> (Any?, String?) {
        guard let body = message.body as? [String: Any], let method = body["method"] as? String else {
            return (nil, "the message has no method")
        }
        let args = body["args"] as? [String: Any] ?? [:]
        if method == "log" {
            logger.debug("\(args["message"] as? String ?? "", privacy: .public)")
            return (true, nil)
        }
        if method == "progress" {
            if let call = args["call"] as? String, let index = (args["index"] as? NSNumber)?.intValue,
               let label = args["label"] as? String
            {
                stepStarted?(PhoneStep(call: call, index: index, label: label))
            }
            return (true, nil)
        }
        guard let page else { return (nil, "closed") }
        do {
            return try await (relay(method, args, on: page), nil)
        } catch let failure as PageFailure {
            return (nil, failure.message)
        } catch {
            return (nil, error.localizedDescription)
        }
    }

    /// Does what the runtime asked of the page; throws `PageFailure` with the runtime's words.
    private func relay(_ method: String, _ args: [String: Any], on page: MarketplacePage) async throws -> Any {
        let timeout = Self.duration(args["timeoutMs"])
        switch method {
        case "navigate":
            guard let url = (args["url"] as? String).flatMap(URL.init(string:)) else { throw PageFailure("blocked") }
            return try await page.navigate(url, timeout: timeout)
        case "settle":
            return try await page.settle(timeout: timeout)
        case "state":
            return page.state()
        case "evaluate", "pageData":
            return try await script(method, args, on: page, timeout: timeout)
        case "acceptNextDialog":
            page.acceptNextDialog()
            return true
        case "fetchPhoto":
            guard let url = (args["url"] as? String).flatMap(URL.init(string:))
            else { throw PageFailure("unreachable") }
            return try await Self.fetchPhoto(url, timeout: timeout)
        case "handOff":
            return await handOff(
                page,
                check: args["kind"] as? String ?? "check",
                marketplace: args["marketplace"] as? String ?? "",
            )
        default:
            throw PageFailure("unknown method \(method)")
        }
    }

    /// Runs script in the page: one of the runtime's page functions, or the page's own data.
    private func script(
        _ method: String,
        _ args: [String: Any],
        on page: MarketplacePage,
        timeout: Duration,
    ) async throws -> Any {
        if method == "pageData" {
            return try await page.pageData(args["name"] as? String ?? "", timeout: timeout)
        }
        let source = args["body"] as? String ?? ""
        return try await page.evaluate(source, args["args"] as? [String: Any] ?? [:], timeout: timeout)
    }

    /// Shows the check to the seller, when the app is open to show it.
    private func handOff(_ page: MarketplacePage, check: String, marketplace: String) async -> String {
        guard UIApplication.shared.applicationState == .active, let handOff else {
            // Nobody to ask now: the seller hears of it, and the run is tried again later.
            await notifier.notify(marketplace: marketplace)
            return "unavailable"
        }
        page.handingOff = true
        defer { page.handingOff = false }
        return await handOff.handOff(page.webView, check: check, marketplace: marketplace)
    }

    private static func duration(_ value: Any?) -> Duration {
        .milliseconds((value as? NSNumber)?.intValue ?? 30000)
    }

    /// One of Listora's listing photos, over HTTPS (HTTP only for a local development host).
    private static func fetchPhoto(_ url: URL, timeout: Duration) async throws -> [String: Any] {
        let local = url.host == "127.0.0.1" || url.host == "localhost"
        guard url.scheme == "https" || (local && url.scheme == "http") else {
            throw PageFailure("blocked")
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = Double(timeout.components.seconds) + 1
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, !data.isEmpty else {
            throw PageFailure("unreachable")
        }
        let mimeType = http.mimeType ?? "image/jpeg"
        let name = url.lastPathComponent.hasSuffix(".jpg") ? url.lastPathComponent : "\(url.lastPathComponent).jpg"
        return ["name": name, "mimeType": mimeType, "base64": data.base64EncodedString()]
    }
}

/// Holds the message handler weakly: the web view keeps its handler, which must not keep the
/// runtime.
private final class BridgeProxy: NSObject, WKScriptMessageHandlerWithReply {
    weak var runtime: WebPhoneRuntime?

    init(_ runtime: WebPhoneRuntime) {
        self.runtime = runtime
    }

    @MainActor
    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
    ) async -> (Any?, String?) {
        guard let runtime else { return (nil, "closed") }
        return await runtime.handle(message)
    }
}

/// A host failure, in the runtime's words (`timeout`, `unreachable`, `blocked`, `closed`, or a
/// page function's own message).
struct PageFailure: Error {
    let message: String

    init(_ message: String) {
        self.message = message
    }
}

/// Keeps the web views in a window of their own, out of sight, so WebKit treats their pages as
/// visible and never throttles their timers (a web view outside any window is), and so a page
/// that focuses one of its fields never brings up the keyboard while Listora works in the
/// background: the shelf's window can never become the key window, which the keyboard follows.
/// The check hand-off (ChallengeHandOffView) moves a page into a window of its own, where the
/// seller types as usual.
@MainActor
final class WebViewShelf {
    static let shared = WebViewShelf()
    private let shelf = UIView(frame: CGRect(x: -20000, y: 0, width: 1280, height: 900))
    private var window: UIWindow?

    /// Keeps `view` on the shelf at `size` (a marketplace page is desktop-sized).
    func keep(_ view: WKWebView, size: CGSize = CGSize(width: 1280, height: 900)) {
        if shelf.superview == nil {
            shelf.isUserInteractionEnabled = false
            shelf.accessibilityElementsHidden = true
            if let scene = Self.scene() {
                let window = ShelfWindow(windowScene: scene)
                window.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.normal.rawValue - 1)
                window.backgroundColor = .clear
                window.isUserInteractionEnabled = false
                window.accessibilityElementsHidden = true
                window.isHidden = false
                window.addSubview(shelf)
                self.window = window
            } else if let window = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene }).flatMap(\.windows).first
            {
                window.insertSubview(shelf, at: 0)
            }
        }
        view.endEditing(true)
        view.removeFromSuperview()
        view.translatesAutoresizingMaskIntoConstraints = true
        view.frame = CGRect(origin: .zero, size: size)
        shelf.addSubview(view)
    }

    private static func scene() -> UIWindowScene? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
    }
}

/// A window that never becomes key, so nothing in it ever owns the keyboard.
private final class ShelfWindow: UIWindow {
    override var canBecomeKey: Bool {
        false
    }
}

/// The controller page's one load.
@MainActor
final class ControllerLoad: NSObject, WKNavigationDelegate {
    let loaded = OneShot<Void>()

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
