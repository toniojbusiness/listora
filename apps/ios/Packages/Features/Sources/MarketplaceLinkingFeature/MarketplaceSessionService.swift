import APIClient
import DesignSystem
import Foundation
import ListoraAPI

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
    public let displayName: String?
    /// Where its automated steps run, as the server says it (`Runs on your iPhone`).
    public let runsOn: RunsOn?

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
            displayName: displayName,
            runsOn: runsOn,
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
        displayName: String? = nil,
        runsOn: RunsOn? = nil,
    ) {
        self.runsOn = runsOn
        self.marketplace = marketplace
        self.name = name
        self.state = state
        self.statusLabel = statusLabel
        self.statusTone = statusTone
        self.statusDetail = statusDetail
        self.loginURL = loginURL
        self.cookieDomains = cookieDomains
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
    /// Changes and checks waiting for that phone.
    public let waiting: Int

    public init(label: String, phone: Bool, installationID: String?, deviceName: String?, waiting: Int) {
        self.label = label
        self.phone = phone
        self.installationID = installationID
        self.deviceName = deviceName
        self.waiting = waiting
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

/// The API calls of the Link accounts screen. A link takes the caller's Idempotency-Key, so a
/// retry after a lost answer stores the session once.
public protocol MarketplaceSessionService: Sendable {
    func list() async throws(APIFailure) -> [MarketplaceLink]
    func get(_ marketplace: String) async throws(APIFailure) -> MarketplaceLink
    /// Links the session; `installationID` names this device, which then runs the marketplace
    /// when it runs on the phone.
    func link(
        _ marketplace: String,
        cookies: [CapturedCookie],
        installationID: String?,
        idempotencyKey: String,
    ) async throws(APIFailure) -> MarketplaceLink
    /// Unlinks the marketplace (`disconnectConnection`): the server deletes the session or
    /// tokens and the data that came through them, and asks the marketplace to revoke access.
    /// Unlinking one that is no longer linked succeeds, so a retry after a lost answer is safe.
    func unlink(_ marketplace: String) async throws(APIFailure)
    /// Asks Listora to check the session it already holds again (the connection's Retry check);
    /// read the session afterwards for the check's status.
    func requestCheck(_ marketplace: String, idempotencyKey: String) async throws(APIFailure)
}

/// `MarketplaceSessionService` on the Listora API.
public struct APIMarketplaceSessionService: MarketplaceSessionService {
    private let api: APIClient

    public init(api: APIClient) {
        self.api = api
    }

    public func list() async throws(APIFailure) -> [MarketplaceLink] {
        let output = try await call { try await api.client.listMarketplaceSessions() }
        switch output {
        case let .ok(response):
            let sessions = try decode { try response.body.json.data }
            return try sessions.map { session throws(APIFailure) in try MarketplaceLink(session) }
        case let .default(status, response):
            throw APIFailure(statusCode: status, response: response)
        }
    }

    public func get(_ marketplace: String) async throws(APIFailure) -> MarketplaceLink {
        let path = try pathMarketplace(marketplace)
        let output = try await call { try await api.client.getMarketplaceSession(path: .init(marketplace: path)) }
        switch output {
        case let .ok(response):
            return try MarketplaceLink(decode { try response.body.json })
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .default(status, response):
            throw APIFailure(statusCode: status, response: response)
        }
    }

    public func link(
        _ marketplace: String,
        cookies: [CapturedCookie],
        installationID: String?,
        idempotencyKey: String,
    ) async throws(APIFailure) -> MarketplaceLink {
        let path = try pathMarketplace(marketplace)
        let output = try await call {
            try await api.client.linkMarketplaceSession(
                path: .init(marketplace: path),
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(.init(
                    cookies: cookies.map(Components.Schemas.SessionCookie.init),
                    installationId: installationID,
                )),
            )
        }
        switch output {
        case let .created(response):
            return try MarketplaceLink(decode { try response.body.json })
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response):
            throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response):
            throw APIFailure(statusCode: 422, response: response)
        case let .default(status, response):
            throw APIFailure(statusCode: status, response: response)
        }
    }

    public func unlink(_ marketplace: String) async throws(APIFailure) {
        let path = try pathMarketplace(marketplace)
        let output = try await call {
            try await api.client.disconnectConnection(path: .init(marketplace: path))
        }
        switch output {
        case .ok:
            return
        case .notFound:
            // Nothing is linked: already unlinked (an earlier try whose answer was lost).
            return
        case let .default(status, response):
            throw APIFailure(statusCode: status, response: response)
        }
    }

    public func requestCheck(_ marketplace: String, idempotencyKey: String) async throws(APIFailure) {
        let path = try pathMarketplace(marketplace)
        let output = try await call {
            try await api.client.requestConnectionCheck(
                path: .init(marketplace: path),
                headers: .init(idempotencyKey: idempotencyKey),
            )
        }
        switch output {
        case .accepted:
            return
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response):
            throw APIFailure(statusCode: 409, response: response)
        case let .default(status, response):
            throw APIFailure(statusCode: status, response: response)
        }
    }

    private func pathMarketplace(_ marketplace: String) throws(APIFailure) -> Components.Schemas.KnownMarketplace {
        guard let known = Components.Schemas.KnownMarketplace(rawValue: marketplace) else {
            throw APIFailure(
                statusCode: nil,
                code: "unsupported_marketplace",
                message: "This version of Listora can't link that marketplace. Update the app.",
                retryable: false,
            )
        }
        return known
    }

    /// Runs a generated call; a thrown error means no usable answer arrived.
    private func call<Output>(_ body: () async throws -> Output) async throws(APIFailure) -> Output {
        do {
            return try await body()
        } catch {
            throw APIFailure(error)
        }
    }

    private func decode<Value>(_ body: () throws -> Value) throws(APIFailure) -> Value {
        do {
            return try body()
        } catch {
            throw APIFailure(error)
        }
    }
}

extension MarketplaceLink {
    init(_ session: Components.Schemas.MarketplaceSession) throws(APIFailure) {
        let marketplace = session.marketplace.value1?.rawValue ?? session.marketplace.value2 ?? ""
        guard let loginURL = URL(string: session.login.url) else {
            throw APIFailure(
                statusCode: nil,
                code: "invalid_response",
                message: "Listora sent a sign-in page this app can't open.",
                retryable: false,
            )
        }
        let message = session.issue?.message ?? session.statusDisplay.detail ?? session.statusDisplay.label
        let state: State = switch session.status.value1 {
        case .notLinked: .notLinked
        case .checking: .checking
        case .linked: .linked
        case .needsRelink: .needsRelink(message: message)
        case .checkFailed: .checkFailed(message: message)
        case .apiConnected: .apiConnected
        case nil: .unknown
        }
        self.init(
            marketplace: marketplace,
            name: Self.name(of: marketplace),
            state: state,
            statusLabel: session.statusDisplay.label,
            statusTone: StatusLabel.Tone(session.statusDisplay.tone),
            statusDetail: session.statusDisplay.detail,
            loginURL: loginURL,
            cookieDomains: session.login.cookieDomains,
            displayName: session.displayName,
            runsOn: session.execution.map(RunsOn.init),
        )
    }

    private static func name(of marketplace: String) -> String {
        switch marketplace {
        case "poshmark": "Poshmark"
        case "mercari": "Mercari"
        case "depop": "Depop"
        case "ebay": "eBay"
        default: marketplace.capitalized
        }
    }
}

extension Components.Schemas.SessionCookie {
    init(_ cookie: CapturedCookie) {
        let sameSite: SameSitePayload = switch cookie.sameSite {
        case .strict: .strict
        case .lax: .lax
        case .none: .none
        }
        self.init(
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            expires: cookie.expires,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: sameSite,
        )
    }
}

extension StatusLabel.Tone {
    /// A tone added after this build is styled like `neutral` (the label is still shown).
    init(_ tone: Components.Schemas.StatusTone) {
        switch tone.value1 {
        case .success: self = .success
        case .inProgress: self = .inProgress
        case .checking: self = .checking
        case .failed: self = .failed
        case .actionNeeded: self = .actionNeeded
        case .neutral, nil: self = .neutral
        }
    }
}

extension RunsOn {
    init(_ execution: Components.Schemas.ConnectionExecution) {
        self.init(
            label: execution.label,
            phone: execution.location.value1 == .phone,
            installationID: execution.deviceInstallationId,
            deviceName: execution.deviceName,
            waiting: Int(execution.waiting ?? 0),
        )
    }
}
