import DesignSystem
import Foundation

/// A marketplace the user links by signing in on its own page (Poshmark, Mercari, Depop, eBay), as
/// the server reports it. The state comes from the server: the app never decides on its own
/// that a marketplace is linked.
public struct MarketplaceLink: Identifiable, Equatable, Sendable {
    public enum State: Equatable, Sendable {
        case notLinked
        /// A session was just linked; the server is checking that the marketplace accepts it.
        case checking
        /// The check passed: Listora automates the marketplace in this session.
        case linked
        /// The marketplace rejected the session or showed a check; the user signs in again.
        case needsRelink(message: String)
        /// Listora could not confirm the session works (its check failed or did not finish);
        /// Check again checks the same session, and linking again checks a new one.
        case checkFailed(message: String)
        /// Connected through the marketplace's API: nothing to sign in to.
        case apiConnected
        /// A state added after this build; the server's label says what it is.
        case unknown
    }

    /// The marketplace's id (`poshmark`).
    public let marketplace: String
    public let name: String
    public let state: State
    /// The server's honest status, shown as given (`Linked`, `Checking...`, `Sign in again`).
    public let statusLabel: String
    public let statusTone: StatusLabel.Tone
    public let statusDetail: String?
    /// The marketplace's own sign-in page.
    public let loginURL: URL
    /// The marketplace's domains; only their cookies are handed over.
    public let cookieDomains: [String]
    /// The marketplace may sign in with a link it emails (Depop): the sign-in page asks for that
    /// link to be copied or shared to Listora instead of tapped (`MarketplaceSignInModel`).
    public let emailsSignInLinks: Bool
    public let displayName: String?
    /// Where its automated steps run, as the server says it (`Runs on your iPhone`).
    public let runsOn: RunsOn?
    /// Listora only reads this account and never changes anything on it, as the server says
    /// (docs/features/read-only.md).
    public let readOnly: Bool

    public var id: String {
        marketplace
    }

    /// Whether the user can sign in now: not while a check runs, and not for an API connection.
    public var canLink: Bool {
        switch state {
        case .notLinked, .linked, .needsRelink, .checkFailed, .unknown: true
        case .checking, .apiConnected: false
        }
    }

    /// Whether there is a link to remove: a session (in any state) or an API connection.
    public var canUnlink: Bool {
        state != .notLinked
    }

    /// Whether the account can be made read only, or writable again: only a linked one.
    public var canSetReadOnly: Bool {
        state != .notLinked
    }

    /// The same marketplace once the server confirmed it is unlinked.
    func unlinked() -> MarketplaceLink {
        MarketplaceLink(
            marketplace: marketplace,
            name: name,
            state: .notLinked,
            statusLabel: "Not linked",
            statusTone: .neutral,
            loginURL: loginURL,
            cookieDomains: cookieDomains,
            emailsSignInLinks: emailsSignInLinks,
        )
    }

    /// The same marketplace once the server confirmed its read-only setting changed.
    func with(readOnly: Bool) -> MarketplaceLink {
        MarketplaceLink(
            marketplace: marketplace,
            name: name,
            state: state,
            statusLabel: statusLabel,
            statusTone: statusTone,
            statusDetail: statusDetail,
            loginURL: loginURL,
            cookieDomains: cookieDomains,
            emailsSignInLinks: emailsSignInLinks,
            displayName: displayName,
            runsOn: runsOn,
            readOnly: readOnly,
        )
    }

    /// "Link" for a first link, "Relink" once there was a session.
    public var linkActionTitle: String {
        state == .notLinked ? "Link" : "Relink"
    }

    /// Whether Listora can check the session it holds again, without the user signing in.
    public var canCheckAgain: Bool {
        if case .checkFailed = state {
            true
        } else {
            false
        }
    }

    /// This link while the server checks it again, as the server words it, for when the check
    /// was accepted but the session could not be read back yet.
    var checking: MarketplaceLink {
        MarketplaceLink(
            marketplace: marketplace,
            name: name,
            state: .checking,
            statusLabel: "Checking...",
            statusTone: .checking,
            loginURL: loginURL,
            cookieDomains: cookieDomains,
            emailsSignInLinks: emailsSignInLinks,
            displayName: displayName,
            runsOn: runsOn,
            readOnly: readOnly,
        )
    }

    public init(
        marketplace: String,
        name: String,
        state: State,
        statusLabel: String,
        statusTone: StatusLabel.Tone,
        statusDetail: String? = nil,
        loginURL: URL,
        cookieDomains: [String],
        emailsSignInLinks: Bool = false,
        displayName: String? = nil,
        runsOn: RunsOn? = nil,
        readOnly: Bool = false,
    ) {
        self.runsOn = runsOn
        self.readOnly = readOnly
        self.marketplace = marketplace
        self.name = name
        self.state = state
        self.statusLabel = statusLabel
        self.statusTone = statusTone
        self.statusDetail = statusDetail
        self.loginURL = loginURL
        self.cookieDomains = cookieDomains
        self.emailsSignInLinks = emailsSignInLinks
        self.displayName = displayName
    }
}

/// Where a linked marketplace's automated steps run (docs/features/phone-execution.md).
public struct RunsOn: Equatable, Sendable {
    /// The server's words: `Runs on your iPhone`, `Runs in Listora's cloud`.
    public let label: String
    /// It runs on a phone (this one, when `installationID` is this app's).
    public let phone: Bool
    public let installationID: String?
    public let deviceName: String?

    public init(label: String, phone: Bool, installationID: String?, deviceName: String?) {
        self.label = label
        self.phone = phone
        self.installationID = installationID
        self.deviceName = deviceName
    }

    /// What the row shows, for this installation: "Runs on this iPhone", or the other phone's name.
    public func text(thisInstallation: String) -> String {
        guard phone, let installationID else { return label }
        if installationID == thisInstallation {
            return "Runs on this iPhone"
        }
        return deviceName.map { "Runs on \($0)" } ?? label
    }
}
