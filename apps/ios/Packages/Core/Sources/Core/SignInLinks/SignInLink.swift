import Foundation
import Security
import Synchronization

/// Which links may sign the user in to one marketplace inside Listora's sign-in page: the links
/// a marketplace such as Depop emails instead of asking for a password. Tapped in the email, such
/// a link opens the phone's default browser and signs in there, where Listora never gets the
/// session, so the user copies it (or shares it to Listora) and the app opens it in its own
/// sign-in page instead. Only a link on the marketplace's own site is ever opened.
public struct SignInLinkRule: Codable, Equatable, Sendable {
    /// The marketplace's sign-in page, as the server sent it.
    public let loginURL: URL
    /// The marketplace's domains (`depop.com`), as the server sent them: a link must be on one of
    /// them or a subdomain of one, never a look-alike such as `notdepop.com`.
    public let domains: [String]

    public init(loginURL: URL, domains: [String]) {
        self.loginURL = loginURL
        self.domains = domains
    }

    /// The contract's limit for a URL.
    static let maxLength = 2048

    /// Whether `url` is a sign-in link this rule lets the sign-in page open: https (or the sign-in
    /// page's own scheme and port, as on the local stand-in sites in development), on one of the
    /// marketplace's domains, with no user name or password in it.
    public func accepts(_ url: URL) -> Bool {
        guard url.absoluteString.count <= Self.maxLength,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(), !host.isEmpty,
              components.user == nil, components.password == nil
        else {
            return false
        }
        let loginScheme = loginURL.scheme?.lowercased()
        switch scheme {
        case "https":
            // The default port, or the sign-in page's own (a stand-in site on another port).
            guard components.port == nil || components.port == 443
                || (loginScheme == "https" && components.port == loginURL.port)
            else {
                return false
            }
        case "http":
            // Only where the sign-in page itself is http: the local stand-in sites.
            guard loginScheme == "http", components.port == loginURL.port else { return false }
        default:
            return false
        }
        let bareHost = host.hasSuffix(".") ? String(host.dropLast()) : host
        return domains.contains { domain in
            let domain = domain.lowercased()
            return bareHost == domain || bareHost.hasSuffix(".\(domain)")
        }
    }

    /// The first link in `text` (what the user pasted or shared) that this rule accepts. Copying a
    /// link gives the link alone; a copied message or a share may carry it among other words.
    public func link(in text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: trimmed), accepts(url) {
            return url
        }
        return SharedContent.links(in: text).first(where: accepts)
    }
}

/// The marketplace whose sign-in page waits for an emailed sign-in link, for the Share Extension.
public struct SignInLinkRequest: Codable, Equatable, Sendable {
    /// The marketplace's id (`depop`).
    public let marketplace: String
    /// Its name, for the extension's message (`Depop`).
    public let name: String
    public let rule: SignInLinkRule
    /// The request lapses then: a link shared long after the sign-in page closed is not taken.
    public let expiresAt: Date

    public init(marketplace: String, name: String, rule: SignInLinkRule, expiresAt: Date) {
        self.marketplace = marketplace
        self.name = name
        self.rule = rule
        self.expiresAt = expiresAt
    }
}

/// Hands an emailed sign-in link from the Share Extension to the app's open sign-in page. The
/// app says which marketplace's page waits for a link (`expect`); the extension, given a link on
/// that marketplace's site, leaves it (`deliver`); the page takes it when the user comes back
/// (`take`), at most once. Closing the page clears everything.
public protocol SignInLinkHandoff: Sendable {
    /// The app: `request`'s sign-in page is open and may be given a link.
    func expect(_ request: SignInLinkRequest)
    /// The extension: the page waiting for a link at `now`, if any.
    func expected(now: Date) -> SignInLinkRequest?
    /// The extension: leaves `link` for the waiting page.
    func deliver(_ link: URL)
    /// The app: the link left for `marketplace`'s page, if one was and its rule accepts it. It is
    /// removed, so it opens once.
    func take(for marketplace: String, now: Date) -> URL?
    /// The app: the sign-in page closed.
    func clear()
}

extension SignInLinkHandoff {
    /// The extension: when a sign-in page waits for a link and `content` carries one on that
    /// marketplace's site, leaves it for the page and answers the request; otherwise nil, and the
    /// share is something else (a listing).
    public func deliver(from content: SharedContent, now: Date = Date()) -> SignInLinkRequest? {
        guard let request = expected(now: now),
              let link = content.candidateURLs.first(where: request.rule.accepts)
        else {
            return nil
        }
        deliver(link)
        return request
    }
}

/// What the handoff keeps: the waiting page and, once shared, its link.
private struct PendingSignInLink: Codable, Equatable {
    var request: SignInLinkRequest
    var link: URL?

    func link(for marketplace: String, now: Date) -> URL? {
        guard request.marketplace == marketplace, request.expiresAt > now,
              let link, request.rule.accepts(link)
        else {
            return nil
        }
        return link
    }
}

/// The handoff in the Keychain group the app shares with its Share Extension (the session's,
/// `AppConfiguration.sessionKeychainGroup`): a sign-in link signs the user in, so it is kept like
/// a credential, on this device only, and only until the sign-in page takes it or closes.
public struct KeychainSignInLinkHandoff: SignInLinkHandoff {
    private let service: String
    private let accessGroup: String?

    public init(accessGroup: String?, service: String = "com.listora.app.sign-in-link") {
        self.accessGroup = accessGroup
        self.service = service
    }

    public func expect(_ request: SignInLinkRequest) {
        write(PendingSignInLink(request: request))
    }

    public func expected(now: Date) -> SignInLinkRequest? {
        guard let pending = read(), pending.request.expiresAt > now else { return nil }
        return pending.request
    }

    public func deliver(_ link: URL) {
        guard var pending = read() else { return }
        pending.link = link
        write(pending)
    }

    public func take(for marketplace: String, now: Date) -> URL? {
        guard var pending = read(), pending.link != nil else { return nil }
        let link = pending.link(for: marketplace, now: now)
        pending.link = nil
        write(pending)
        return link
    }

    public func clear() {
        SecItemDelete(query as CFDictionary)
    }

    private func read() -> PendingSignInLink? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else {
            return nil
        }
        return try? JSONDecoder().decode(PendingSignInLink.self, from: data)
    }

    private func write(_ pending: PendingSignInLink) {
        SecItemDelete(query as CFDictionary)
        guard let data = try? JSONEncoder().encode(pending) else { return }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    private var query: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "pending",
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
            query[kSecUseDataProtectionKeychain as String] = true
        }
        return query
    }
}

/// The handoff in memory only: for tests and previews.
public final class InMemorySignInLinkHandoff: SignInLinkHandoff {
    private let pending = Mutex<PendingSignInLink?>(nil)

    public init() {}

    public func expect(_ request: SignInLinkRequest) {
        pending.withLock { $0 = PendingSignInLink(request: request) }
    }

    public func expected(now: Date) -> SignInLinkRequest? {
        pending.withLock { pending in
            pending.flatMap { $0.request.expiresAt > now ? $0.request : nil }
        }
    }

    public func deliver(_ link: URL) {
        pending.withLock { $0?.link = link }
    }

    public func take(for marketplace: String, now: Date) -> URL? {
        pending.withLock { pending in
            let link = pending?.link(for: marketplace, now: now)
            pending?.link = nil
            return link
        }
    }

    public func clear() {
        pending.withLock { $0 = nil }
    }
}
