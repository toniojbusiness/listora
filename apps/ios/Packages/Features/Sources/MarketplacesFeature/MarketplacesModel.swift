import APIClient
import DesignSystem
import Foundation
import ListoraAPI
import Observation

/// The Marketplaces screen and the app's connection banner: every marketplace with its
/// connection's health (the server's `getConnectionHealth`), connecting an API marketplace (eBay)
/// through its consent page, and Retry check.
///
/// Connecting never trusts the consent sheet's return: after it closes, the model reads the
/// attempt back from the server and reloads the list, so a row says "Connected" only when the
/// server does. Retry check shows the server's "Checking" and reloads until the server has an
/// answer.
@MainActor
@Observable
public final class MarketplacesModel {
    public enum Phase: Equatable {
        case loading
        case loaded
        /// The list could not be loaded; `message` is safe to show.
        case failed(message: String)
    }

    public private(set) var rows: [MarketplaceRow] = []
    public private(set) var phase: Phase = .loading
    /// The marketplace being connected right now.
    public private(set) var connecting: String?
    /// The marketplace whose check was just asked for, until the server answers the request.
    public private(set) var requestingCheck: String?
    public private(set) var notice: ConnectionNotice?
    /// The app's banner while any connection needs attention; nil when none does or the summary
    /// could not be read (a failure to read it is not a broken connection).
    public private(set) var attention: AttentionBanner?
    /// Forwarding marketplace sale emails to Listora.
    public private(set) var saleForwarding: SaleForwardingRow?

    private let service: any ConnectionsService
    private let pollInterval: Duration
    private let maxPolls: Int
    private let sleep: @Sendable (Duration) async throws -> Void
    private let isSignedIn: @MainActor () -> Bool

    /// `pollInterval` and `maxPolls`: how often and how long a requested check is read again.
    /// `isSignedIn`: whether there is a session; the banner never asks the API without one.
    public init(
        service: any ConnectionsService,
        isSignedIn: @escaping @MainActor () -> Bool = { true },
        pollInterval: Duration = .seconds(2),
        maxPolls: Int = 15,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
    ) {
        self.service = service
        self.pollInterval = pollInterval
        self.maxPolls = maxPolls
        self.sleep = sleep
        self.isSignedIn = isSignedIn
    }

    /// Reloads for the app's banner (on launch, on return to the app, when Inventory appears):
    /// like ``load()``, but signed out it asks nothing and shows no banner.
    public func refreshAttention() async {
        guard isSignedIn() else {
            attention = nil
            return
        }
        await load()
    }

    /// Loads (or reloads) every marketplace's connection and the attention banner.
    public func load() async {
        if rows.isEmpty {
            phase = .loading
        }
        do {
            try await apply(service.health())
            phase = .loaded
        } catch {
            phase = .failed(message: error.isUnauthenticated ? "Sign in to see your marketplaces." : error.message)
            if error.isUnauthenticated {
                attention = nil
            }
        }
    }

    /// Retry check: asks the server to check the row's connection, shows its "Checking" status,
    /// and reads the summary again until that status changes (or a minute or so has passed).
    public func check(_ row: MarketplaceRow) async {
        guard requestingCheck == nil, connecting == nil, let marketplace = row.marketplace,
              row.actions.contains(.check)
        else { return }
        requestingCheck = row.id
        notice = nil
        let checking: MarketplaceRow
        do {
            checking = try await MarketplaceRow(connection: service.requestCheck(
                marketplace: marketplace,
                idempotencyKey: UUID().uuidString,
            ))
        } catch {
            requestingCheck = nil
            notice = ConnectionNotice(tone: .failure, message: error.message)
            await load()
            return
        }
        requestingCheck = nil
        replace(checking)
        for _ in 0 ..< maxPolls {
            do {
                try await sleep(pollInterval)
            } catch {
                return
            }
            await load()
            guard let current = rows.first(where: { $0.id == row.id }) else { return }
            if current.statusLabel != checking.statusLabel {
                notice = current.tone == .success
                    ? ConnectionNotice(tone: .success, message: "\(row.name) is connected.")
                    : nil
                return
            }
        }
    }

    private func apply(_ summary: Components.Schemas.ConnectionHealthSummary) {
        rows = summary.connections.map(MarketplaceRow.init(connection:))
        attention = summary.banner.flatMap { banner in
            summary.needsAttention ? AttentionBanner(banner: banner, count: summary.attention.count) : nil
        }
        saleForwarding = SaleForwardingRow(summary.saleForwarding)
    }

    private func replace(_ row: MarketplaceRow) {
        if let index = rows.firstIndex(where: { $0.id == row.id }) {
            rows[index] = row
        }
    }

    public func dismissNotice() {
        notice = nil
    }

    /// Connects (or reconnects) the row's marketplace: starts an attempt, runs the consent page in
    /// `authenticate`, then reads the result back from the server.
    public func connect(_ row: MarketplaceRow, authenticate: WebAuthenticator) async {
        guard connecting == nil, requestingCheck == nil, let marketplace = row.marketplace,
              row.actions.contains(where: { $0 == .connect || $0 == .reconnect })
        else { return }
        connecting = row.id
        notice = nil
        defer { connecting = nil }

        let attempt: Components.Schemas.ConnectionAuthorization
        do {
            attempt = try await service.startAuthorization(
                marketplace: marketplace,
                idempotencyKey: UUID().uuidString,
            )
        } catch {
            notice = ConnectionNotice(tone: .failure, message: error.message)
            return
        }
        guard let url = attempt.authorizationUrl.flatMap(URL.init(string:)) else {
            notice = ConnectionNotice(
                tone: .failure,
                message: "Listora couldn't open the \(row.name) sign-in. Try again.",
            )
            return
        }

        let callback: URL
        do {
            callback = try await authenticate(url, attempt.callbackUrlScheme)
        } catch is WebAuthenticationCanceled {
            notice = ConnectionNotice(tone: .info, message: "\(row.name) wasn't connected: you closed the sign-in.")
            return
        } catch {
            notice = ConnectionNotice(tone: .failure, message: "The \(row.name) sign-in didn't finish. Try again.")
            return
        }

        // The callback names the attempt the server settled; without one, read ours.
        let id = Self.authorizationID(in: callback) ?? attempt.id
        do {
            let result = try await service.authorization(marketplace: marketplace, id: id)
            notice = Self.notice(for: result, name: row.name)
        } catch {
            notice = ConnectionNotice(tone: .failure, message: error.message)
        }
        await load()
    }

    static func authorizationID(in callback: URL) -> String? {
        URLComponents(url: callback, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first { $0.name == "authorizationId" }?
            .value
    }

    static func notice(for result: Components.Schemas.ConnectionAuthorization, name: String) -> ConnectionNotice {
        switch result.status {
        case .completed:
            let account = result.connection?.displayName.map { " as \($0)" } ?? ""
            return ConnectionNotice(tone: .success, message: "\(name) is connected\(account).")
        case .failed:
            return ConnectionNotice(
                tone: .failure,
                message: result.failure?.message ?? "\(name) wasn't connected. Try again.",
            )
        case .expired:
            return ConnectionNotice(tone: .failure, message: "The \(name) sign-in took too long. Try again.")
        case .pending:
            return ConnectionNotice(tone: .failure, message: "\(name) didn't finish connecting. Try again.")
        }
    }
}

/// The outcome of the last connection attempt, shown above the list.
public struct ConnectionNotice: Equatable, Sendable {
    public enum Tone: Equatable, Sendable {
        case success
        case info
        case failure
    }

    public let tone: Tone
    public let message: String
}

/// The app's banner while a connection needs attention: the server's words, shown as given.
public struct AttentionBanner: Equatable, Sendable {
    public let title: String
    public let message: String?
    /// True when the seller has to act (reconnect); false for a problem Listora keeps checking.
    public let needsAction: Bool
    /// How many connections need attention (the Settings tab's badge).
    public let count: Int

    public init(title: String, message: String?, needsAction: Bool, count: Int) {
        self.title = title
        self.message = message
        self.needsAction = needsAction
        self.count = count
    }

    init(banner: Components.Schemas.StatusDisplay, count: Int) {
        self.init(
            title: banner.label,
            message: banner.detail,
            needsAction: banner.tone.value1 != .checking,
            count: max(count, 1),
        )
    }
}

/// Sale email forwarding, as the server describes it.
public struct SaleForwardingRow: Equatable, Sendable {
    public let statusLabel: String
    public let statusDetail: String?
    /// The server's tone: `success` only once a marketplace email passed Listora's checks.
    public let tone: StatusTone

    init(_ forwarding: Components.Schemas.SaleForwarding) {
        statusLabel = forwarding.statusDisplay.label
        statusDetail = forwarding.statusDisplay.detail
        tone = switch forwarding.statusDisplay.tone.value1 {
        case .success: .success
        case .inProgress: .inProgress
        case .checking: .checking
        case .failed: .failed
        case .actionNeeded: .actionNeeded
        case .neutral, nil: .neutral
        }
    }
}
