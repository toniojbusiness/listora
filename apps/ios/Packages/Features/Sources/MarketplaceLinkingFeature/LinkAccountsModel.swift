import APIClient
import Foundation
import Observation

/// The Link accounts screen: every marketplace linked by signing in, with the server's status,
/// and the flow that links one. The user signs in on the marketplace's own page inside the app
/// (`MarketplaceSignInView`); the app hands Listora only that site's cookies, and the
/// marketplace shows as linked only once the server's check of the session passed.
@MainActor
@Observable
public final class LinkAccountsModel {
    public enum LoadState: Equatable {
        case loading
        case loaded
        /// The list could not be read; `error.retryable` says whether Try again may help.
        case failed(APIFailure)
    }

    /// Where linking one marketplace stands, apart from its server status.
    public enum LinkProgress: Equatable {
        /// Sending the session to Listora.
        case sending
        /// The session did not reach Listora (or was refused). Retry resends the same sign-in
        /// with the same Idempotency-Key when `error.retryable`; otherwise the user signs in again.
        case failed(APIFailure)
        /// Asking Listora to unlink the marketplace.
        case unlinking
        /// The unlink did not go through; the marketplace is still linked. Retry asks again.
        case unlinkFailed(APIFailure)
    }

    public private(set) var links: [MarketplaceLink] = []
    public private(set) var loadState: LoadState = .loading
    public private(set) var progress: [String: LinkProgress] = [:]
    /// The marketplace whose sign-in page is open.
    public var signingIn: MarketplaceLink?
    /// The marketplace the user asked to unlink, waiting for them to confirm.
    public var confirmingUnlink: MarketplaceLink?

    private let service: any MarketplaceSessionService
    private let makeIdempotencyKey: @Sendable () -> String
    private let sleep: @Sendable (Duration) async throws -> Void
    private let pollInterval: Duration
    private let maxPolls: Int
    private let now: @Sendable () -> Date
    /// The sign-in each failed link would resend: its cookies and its Idempotency-Key.
    private var unsent: [String: (cookies: [CapturedCookie], key: String)] = [:]

    public init(
        service: any MarketplaceSessionService,
        makeIdempotencyKey: @escaping @Sendable () -> String = { UUID().uuidString },
        pollInterval: Duration = .seconds(3),
        maxPolls: Int = 100,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        now: @escaping @Sendable () -> Date = { Date() },
    ) {
        self.service = service
        self.makeIdempotencyKey = makeIdempotencyKey
        self.pollInterval = pollInterval
        self.maxPolls = maxPolls
        self.sleep = sleep
        self.now = now
    }

    /// Reads every marketplace's status, then keeps checking the ones still being checked.
    public func load() async {
        if links.isEmpty {
            loadState = .loading
        }
        do {
            links = try await service.list()
            loadState = .loaded
        } catch {
            loadState = .failed(error)
            return
        }
        await withTaskGroup(of: Void.self) { group in
            for link in links where link.state == .checking {
                group.addTask { await self.followCheck(link.marketplace) }
            }
        }
    }

    /// Opens the marketplace's sign-in page.
    public func startLinking(_ link: MarketplaceLink) {
        guard link.canLink, !isBusy(link.marketplace) else { return }
        signingIn = link
    }

    /// Asks the user to confirm unlinking: it deletes what Listora holds for the marketplace.
    public func requestUnlink(_ link: MarketplaceLink) {
        guard link.canUnlink, !isBusy(link.marketplace) else { return }
        confirmingUnlink = link
    }

    public func cancelUnlink() {
        confirmingUnlink = nil
    }

    /// The user confirmed: unlinks the marketplace, then shows the server's state of it. It
    /// shows as not linked only once the server says so.
    public func confirmUnlink() async {
        guard let link = confirmingUnlink else { return }
        confirmingUnlink = nil
        await unlink(link.marketplace)
    }

    /// Asks again after an unlink that did not go through.
    public func retryUnlink(_ marketplace: String) async {
        guard case let .unlinkFailed(error) = progress[marketplace], error.retryable else { return }
        await unlink(marketplace)
    }

    private func unlink(_ marketplace: String) async {
        progress[marketplace] = .unlinking
        unsent[marketplace] = nil
        do {
            try await service.unlink(marketplace)
        } catch {
            progress[marketplace] = .unlinkFailed(error)
            return
        }
        progress[marketplace] = nil
        do {
            try await replace(service.get(marketplace))
        } catch {
            // The server confirmed the unlink but its fresh state could not be read: show what
            // it confirmed, so the row never keeps saying Linked.
            if let link = links.first(where: { $0.marketplace == marketplace }) {
                replace(link.unlinked())
            }
        }
    }

    private func isBusy(_ marketplace: String) -> Bool {
        switch progress[marketplace] {
        case .sending, .unlinking: true
        case .failed, .unlinkFailed, nil: false
        }
    }

    public func cancelSignIn() {
        signingIn = nil
    }

    /// The user finished signing in: hands over the marketplace's cookies from the sign-in web
    /// view, then follows the server's check of them.
    public func finishSignIn(_ link: MarketplaceLink, cookies: [HTTPCookie]) async {
        signingIn = nil
        let captured = SessionCookies.capture(cookies, domains: link.cookieDomains, now: now())
        guard !captured.isEmpty else {
            unsent[link.marketplace] = nil
            progress[link.marketplace] = .failed(APIFailure(
                statusCode: nil,
                code: "not_signed_in",
                message: "\(link.name) didn't sign you in. Tap \(link.linkActionTitle) and sign in again.",
                retryable: false,
            ))
            return
        }
        let attempt = (cookies: captured, key: makeIdempotencyKey())
        unsent[link.marketplace] = attempt
        await send(link.marketplace, attempt)
    }

    /// Resends a sign-in that did not reach Listora, with the same Idempotency-Key.
    public func retry(_ marketplace: String) async {
        guard case let .failed(error) = progress[marketplace], error.retryable,
              let attempt = unsent[marketplace] else { return }
        await send(marketplace, attempt)
    }

    private func send(_ marketplace: String, _ attempt: (cookies: [CapturedCookie], key: String)) async {
        progress[marketplace] = .sending
        do {
            let updated = try await service.link(marketplace, cookies: attempt.cookies, idempotencyKey: attempt.key)
            unsent[marketplace] = nil
            progress[marketplace] = nil
            replace(updated)
        } catch {
            progress[marketplace] = .failed(error)
            return
        }
        await followCheck(marketplace)
    }

    /// Asks again while the server is still checking the session, until it decides.
    private func followCheck(_ marketplace: String) async {
        for _ in 0 ..< maxPolls {
            guard links.first(where: { $0.marketplace == marketplace })?.state == .checking else { return }
            do {
                try await sleep(pollInterval)
            } catch {
                return
            }
            do {
                let fresh = try await service.get(marketplace)
                replace(fresh)
            } catch {
                // A failed read changes nothing: the row stays Checking..., and the next poll
                // or a refresh asks again.
                continue
            }
        }
    }

    private func replace(_ link: MarketplaceLink) {
        if let index = links.firstIndex(where: { $0.marketplace == link.marketplace }) {
            links[index] = link
        } else {
            links.append(link)
        }
    }
}
