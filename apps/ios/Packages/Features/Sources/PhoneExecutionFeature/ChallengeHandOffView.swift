import DesignSystem
import Observation
import SwiftUI
import UIKit
import WebKit

/// A check a phone run stopped at, waiting for the seller.
public struct HandOffRequest: Identifiable {
    public let id = UUID()
    let page: WKWebView
    /// `captcha`, `bot_check`, `login_challenge`, or `session_rejected`.
    public let check: String
    public let marketplace: String

    /// The marketplace's name, as the seller knows it.
    public var name: String {
        Self.displayName(marketplace)
    }

    static func displayName(_ marketplace: String) -> String {
        switch marketplace {
        case "poshmark": "Poshmark"
        case "mercari": "Mercari"
        case "depop": "Depop"
        case "ebay": "eBay"
        default: marketplace.capitalized
        }
    }

    var title: String {
        check == "session_rejected" ? "Sign in to \(name)" : "\(name) wants to check it's you"
    }

    var message: String {
        let doing = check == "session_rejected" ? "Sign in again below" : "Complete the check below"
        return "\(doing), then tap Done. Listora stopped here and never completes checks for you."
    }
}

/// Hands a check to the seller (docs/features/phone-execution.md): the marketplace page the run
/// stopped at, in a visible in-app browser. The seller completes the check themselves (or
/// signs in again) and taps Done, and the run goes on; Not now leaves the work for later.
/// Listora never solves, skips, or hides a check.
///
/// The browser shows in a window of its own above every screen and sheet, so a check is shown
/// whatever the seller has open (Link accounts is itself a sheet).
@MainActor
@Observable
public final class ChallengeHandOffModel: ChallengeHandOff {
    /// The check showing now.
    public private(set) var request: HandOffRequest?
    private var answer: CheckedContinuation<String, Never>?
    private var window: UIWindow?

    public init() {}

    public func handOff(_ page: WKWebView, check: String, marketplace: String) async -> String {
        // One check at a time; another run's waits for this one to be answered.
        if answer != nil {
            return "declined"
        }
        guard let scene = Self.activeScene() else { return "unavailable" }
        return await withCheckedContinuation { continuation in
            answer = continuation
            let request = HandOffRequest(page: page, check: check, marketplace: marketplace)
            self.request = request
            let window = UIWindow(windowScene: scene)
            window.windowLevel = .alert
            let view = ChallengeHandOffView(request: request, model: self)
            window.rootViewController = UIHostingController(rootView: view)
            window.makeKeyAndVisible()
            self.window = window
        }
    }

    private static func activeScene() -> UIWindowScene? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
    }

    /// The seller completed the check.
    public func done() {
        finish("completed")
    }

    /// The seller closed the browser without it.
    public func notNow() {
        finish("declined")
    }

    private func finish(_ result: String) {
        if let page = request?.page {
            WebViewShelf.shared.keep(page)
        }
        window?.isHidden = true
        window = nil
        request = nil
        answer?.resume(returning: result)
        answer = nil
    }
}

/// The visible in-app browser of a hand-off.
public struct ChallengeHandOffView: View {
    let request: HandOffRequest
    let model: ChallengeHandOffModel

    public init(request: HandOffRequest, model: ChallengeHandOffModel) {
        self.request = request
        self.model = model
    }

    public var body: some View {
        NavigationStack {
            HostedPage(page: request.page)
                .accessibilityIdentifier("handOff.page")
                .safeAreaInset(edge: .top) {
                    Banner(
                        request.title,
                        message: request.message,
                        tone: .actionNeeded,
                        systemImage: "hand.raised",
                        identifier: "handOff.banner",
                    )
                    .padding(Spacing.sm)
                    .background(Palette.surface)
                }
                .navigationTitle(request.name)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Not now") { model.notNow() }
                            .accessibilityIdentifier("handOff.notNow")
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { model.done() }
                            .accessibilityIdentifier("handOff.done")
                    }
                }
        }
        .tint(Palette.brand.color)
    }
}

/// Shows the run's own web view, page and all, until the hand-off ends.
private struct HostedPage: UIViewRepresentable {
    let page: WKWebView

    func makeUIView(context _: Context) -> UIView {
        let container = UIView()
        page.removeFromSuperview()
        page.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(page)
        NSLayoutConstraint.activate([
            page.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            page.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            page.topAnchor.constraint(equalTo: container.topAnchor),
            page.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        return container
    }

    func updateUIView(_: UIView, context _: Context) {}
}
