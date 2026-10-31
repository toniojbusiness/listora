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
    /// server replays its answers through; call it between runs. `false` when the server couldn't
    /// say which it runs.
    @discardableResult
    func refresh() async -> Bool
    /// Tells `handler` each step a call starts, as the runtime reports it.
    func observeSteps(_ handler: @escaping @MainActor (PhoneStep) -> Void)
    /// While the app is open (`true`), keeps a signed-in web view per marketplace ready between
    /// calls, so the next call starts at once; `false` lets them go once their calls end.
    func keepWarm(_ warm: Bool)
}

extension PhoneRuntime {
    @discardableResult
    public func refresh() async -> Bool {
        true
    }

    public func observeSteps(_: @escaping @MainActor (PhoneStep) -> Void) {}
    public func keepWarm(_: Bool) {}
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

/// The phone runtime in the app's own web views. Each marketplace runs in a lane of its own, so
/// marketplaces run side by side: a hidden controller page that runs the bundle, and the
/// marketplace page, an off-screen web view holding the seller's session (the cookies this phone
/// keeps), which the controller reaches through the `listora` message handler, whose every
/// message is answered. The app only relays: it loads pages, evaluates the runtime's page
/// functions, reads the page's own data, reports the main frame's navigations, answers dialogs,
/// fetches listing photos, and hands a check to the seller. Every rule stays in the runtime.
///
/// While the app is open (`keepWarm`), each marketplace's page stays between calls (on a blank
/// page, still signed in, its WebKit process and cache warm), so the next call starts at once; a
/// session that changed meanwhile (a new link, another account) gets a new page. Each listing
/// photo is fetched once and handed to every marketplace that posts it.
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
    /// Each marketplace's controller page and marketplace page.
    private var lanes: [String: RuntimeLane] = [:]
    /// The runtime that runs: the server's, once it handed one out (kept for the next launch), the
    /// app's own copy until then. Read on the first call, not at launch.
    private lazy var scripts = RuntimeScripts(bundled: Self.bundledSource(), store: store)
    private let store = ServedRuntimeStore.caches()
    private let fetchRuntime: @Sendable (_ have: String?) async -> RemoteRuntime?
    private var stepStarted: (@MainActor (PhoneStep) -> Void)?
    private var warm = false
    private let photos: PhotoCache
    /// The marketplaces whose runs the phone may get, for keeping their web views ready.
    private static let marketplaces = ["poshmark", "mercari", "depop", "ebay"]

    /// `photoHosts`: Listora's own photo hosts, the only ones it fetches a listing's photos from.
    public init(
        sessions: any MarketplaceSessionStore,
        handOff: (any ChallengeHandOff)?,
        photoHosts: [URL],
        notifier: CheckNeededNotifier = CheckNeededNotifier(),
        fetchRuntime: @escaping @Sendable (_ have: String?) async -> RemoteRuntime? = { _ in nil },
    ) {
        self.sessions = sessions
        self.handOff = handOff
        photos = PhotoCache(sources: PhotoSources(photoHosts))
        self.notifier = notifier
        self.fetchRuntime = fetchRuntime
        super.init()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(memoryWarning),
            name: UIApplication.didReceiveMemoryWarningNotification,
            object: nil,
        )
    }

    public func observeSteps(_ handler: @escaping @MainActor (PhoneStep) -> Void) {
        stepStarted = handler
    }

    public func keepWarm(_ warm: Bool) {
        self.warm = warm
        guard warm else {
            // The app left the foreground: pages not in a call go now, the rest when it ends.
            for lane in lanes.values where !lane.calling {
                lane.closePage()
            }
            photos.removeAll()
            return
        }
        // The marketplaces this phone holds a session for get their runtime and web view now,
        // before their first call.
        for marketplace in Self.marketplaces where !sessions.cookies(for: marketplace).isEmpty {
            let lane = lane(for: marketplace)
            Task { _ = try? await lane.load(source: self.source()) }
            lane.preparePage(logger: logger)
        }
    }

    @objc private func memoryWarning() {
        for lane in lanes.values where !lane.calling {
            lane.closePage()
        }
        photos.removeAll()
    }

    /// The seller signed out of Listora: every marketplace page goes, with the session it holds.
    public func signedOut() {
        for lane in lanes.values {
            lane.closePage()
        }
        photos.removeAll()
    }

    @discardableResult
    public func refresh() async -> Bool {
        // The server sends its script only when it isn't the one named here.
        guard let remote = await fetchRuntime(scripts.running?.digest) else { return false }
        if scripts.take(remote) {
            // The next call of each marketplace loads it into a new controller page.
            for lane in lanes.values {
                lane.dropController()
            }
        }
        return true
    }

    public func runtimeVersion() async throws -> Int {
        // Any marketplace's controller answers it: they all run the same bundle.
        try await (lanes.values.first ?? lane(for: Self.marketplaces[0])).load(source: source())
    }

    public func run(_ input: Data, marketplace: String) async throws -> Data {
        let object = try JSONSerialization.jsonObject(with: input)
        let call = object as? [String: Any] ?? [:]
        // The phone's own read-only refusal comes first, before any of the runtime's script runs.
        if let refused = PhoneReadOnlyGuard.refusal(of: call, marketplace: marketplace, sessions: sessions) {
            return try JSONSerialization.data(withJSONObject: refused)
        }
        let lane = lane(for: marketplace)
        _ = try await lane.load(source: source())
        guard let controller = lane.controller else { throw PhoneRuntimeError.bundleNotLoaded("no controller page") }
        let domains = call["cookieDomains"] as? [String] ?? []
        let origins = call["origins"] as? [String] ?? []
        let stored = sessions.cookies(for: marketplace).filter { $0.belongs(to: domains) }
        let page = await lane.page(origins: origins, domains: domains, session: stored, logger: logger)
        lane.calling = true
        defer {
            lane.calling = false
            if !warm {
                lane.closePage()
            }
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
            lane.session = refreshed
        }
        page.rest()
        guard let result, JSONSerialization.isValidJSONObject(result) else {
            throw PhoneRuntimeError.invalidAnswer
        }
        return try JSONSerialization.data(withJSONObject: result)
    }

    private func lane(for marketplace: String) -> RuntimeLane {
        if let lane = lanes[marketplace] {
            return lane
        }
        let lane = RuntimeLane(marketplace: marketplace) { [weak self] message in
            await self?.handle(message, marketplace: marketplace) ?? (nil, "closed")
        }
        lanes[marketplace] = lane
        return lane
    }

    /// The runtime's script: the server's when it handed one out, else the app's own.
    private func source() -> String? {
        scripts.running?.source
    }

    /// The script the comparison lane runs too (`WebMarketComparisons`).
    func currentSource() -> String? {
        source()
    }

    /// The runtime the app was built with, which runs until the server hands out its own.
    private static func bundledSource() -> String? {
        guard let url = Bundle.module.url(forResource: "phone-runtime", withExtension: "js") else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    /// One message from a marketplace's runtime; the reply is its answer, or the failure's
    /// message.
    fileprivate func handle(_ message: WKScriptMessage, marketplace: String) async -> (Any?, String?) {
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
                stepStarted?(PhoneStep(marketplace: marketplace, call: call, index: index, label: label))
            }
            return (true, nil)
        }
        guard let page = lanes[marketplace]?.currentPage, lanes[marketplace]?.calling == true else {
            return (nil, "closed")
        }
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
            return try await photos.photo(url, timeout: timeout)
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
