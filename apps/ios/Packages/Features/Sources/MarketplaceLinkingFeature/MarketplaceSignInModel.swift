import Core
import Foundation
import Observation

/// One marketplace's sign-in page: what it opens, and, for a marketplace that signs in with a
/// link it emails (Depop), the emailed link the user brings back. Tapped in the email, that link
/// would sign in the phone's default browser, where Listora never gets the session, so the user
/// copies it and pastes it here, or shares it to Listora; either way it opens in this same page
/// (the same web view and data store), and "I'm signed in" then hands over its cookies as for
/// any sign-in. Only a link on the marketplace's own site is opened (`SignInLinkRule`).
@MainActor
@Observable
public final class MarketplaceSignInModel {
    /// A page for the web view to open. Each has its own id, so opening the same link again
    /// (after the user went back) loads it again.
    public struct Navigation: Equatable, Identifiable, Sendable {
        public let id: Int
        public let url: URL
    }

    public let link: MarketplaceLink
    /// The links the page may open; nil for a marketplace that emails none.
    public let rule: SignInLinkRule?
    /// The page the web view shows: the sign-in page, then any emailed link.
    public private(set) var navigation: Navigation
    /// Why the pasted text was not opened, until the next paste or link.
    public private(set) var linkProblem: String?
    /// An emailed link was opened in the page.
    public private(set) var openedEmailedLink = false

    private let handoff: (any SignInLinkHandoff)?
    private let now: @Sendable () -> Date

    /// How long a shared link is taken after the page opened: an emailed link lapses within
    /// minutes, and a page left open longer is reopened anyway.
    static let shareWindow: TimeInterval = 30 * 60

    public init(
        link: MarketplaceLink,
        handoff: (any SignInLinkHandoff)? = nil,
        now: @escaping @Sendable () -> Date = { Date() },
    ) {
        self.link = link
        self.handoff = handoff
        self.now = now
        rule = link.emailsSignInLinks ? SignInLinkRule(loginURL: link.loginURL, domains: link.cookieDomains) : nil
        navigation = Navigation(id: 0, url: link.loginURL)
    }

    /// The page opened: a link shared to Listora from now on comes to it.
    public func appeared() {
        guard let rule else { return }
        handoff?.expect(SignInLinkRequest(
            marketplace: link.marketplace,
            name: link.name,
            rule: rule,
            expiresAt: now().addingTimeInterval(Self.shareWindow),
        ))
    }

    /// The user came back to Listora: opens the link they shared to it, if any.
    public func becameActive() {
        guard rule != nil, let shared = handoff?.take(for: link.marketplace, now: now()) else { return }
        open(shared)
    }

    /// The user pasted `texts` (the pasteboard's link or text): opens the first sign-in link on
    /// the marketplace's site among them, or says why nothing opened.
    public func paste(_ texts: [String]) {
        guard let rule else { return }
        guard let pasted = texts.lazy.compactMap(rule.link(in:)).first else {
            linkProblem = texts.allSatisfy { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                ? "Nothing to paste. In \(link.name)'s email, press and hold the sign-in link. If a preview opens, "
                + "tap Hide preview, then Copy link. Then come back and tap Paste sign-in link."
                : "That isn't a \(link.name) sign-in link. Copy the link in \(link.name)'s email and paste it again."
            return
        }
        open(pasted)
    }

    /// The page closed: a link shared from now on is not taken.
    public func closed() {
        guard rule != nil else { return }
        handoff?.clear()
    }

    private func open(_ url: URL) {
        linkProblem = nil
        openedEmailedLink = true
        navigation = Navigation(id: navigation.id + 1, url: url)
    }
}
