import APIClient
import DesignSystem
import Foundation
import ListoraAPI

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
            emailsSignInLinks: session.login.emailsSignInLinks ?? false,
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
