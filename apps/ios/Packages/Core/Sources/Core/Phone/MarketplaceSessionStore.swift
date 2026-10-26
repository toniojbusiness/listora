import Foundation
import Security
import Synchronization

/// One cookie of a marketplace session, as the phone keeps it (docs/features/phone-execution.md).
public struct StoredCookie: Codable, Equatable, Sendable {
    public var name: String
    public var value: String
    public var domain: String
    public var path: String
    /// `nil` for a cookie that lasts as long as the browser session.
    public var expires: Date?
    public var secure: Bool
    public var httpOnly: Bool
    /// `Strict`, `Lax`, or `None`; `nil` when the site set none.
    public var sameSite: String?

    public init(
        name: String,
        value: String,
        domain: String,
        path: String,
        expires: Date?,
        secure: Bool,
        httpOnly: Bool,
        sameSite: String?,
    ) {
        self.name = name
        self.value = value
        self.domain = domain
        self.path = path
        self.expires = expires
        self.secure = secure
        self.httpOnly = httpOnly
        self.sameSite = sameSite
    }

    public init(_ cookie: HTTPCookie) {
        self.init(
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            expires: cookie.expiresDate,
            secure: cookie.isSecure,
            httpOnly: cookie.isHTTPOnly,
            sameSite: cookie.sameSitePolicy?.rawValue,
        )
    }

    /// The cookie for a web view's cookie store.
    public var httpCookie: HTTPCookie? {
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: name,
            .value: value,
            .domain: domain,
            .path: path,
        ]
        if let expires {
            properties[.expires] = expires
        }
        if secure {
            properties[.secure] = "TRUE"
        }
        if httpOnly {
            properties[HTTPCookiePropertyKey("HttpOnly")] = "TRUE"
        }
        if let sameSite {
            properties[.sameSitePolicy] = sameSite
        }
        return HTTPCookie(properties: properties)
    }

    /// Whether the cookie belongs to one of `domains` (the domain itself or a subdomain), never a
    /// look-alike such as `notdepop.com`.
    public func belongs(to domains: [String]) -> Bool {
        let host = domain.hasPrefix(".") ? String(domain.dropFirst()) : domain
        return domains.contains { host == $0 || host.hasSuffix(".\($0)") }
    }
}

/// The marketplace sessions this phone holds: the cookies the seller's sign-in left in the
/// app's web view, which the phone runtime acts with when a marketplace runs on this phone. The
/// linking flow saves them and every phone run stores the cookies the marketplace refreshed.
///
/// The sessions belong to one Listora account: signing in to another one on this phone removes
/// them (`keep(onlyFor:)`), so one account's runs never act in another seller's sessions.
public protocol MarketplaceSessionStore: Sendable {
    func cookies(for marketplace: String) -> [StoredCookie]
    func save(_ cookies: [StoredCookie], for marketplace: String)
    /// The account signed in now: the sessions of any other account are removed.
    func keep(onlyFor account: String)
    func removeAll()
}

/// The sessions in the Keychain, readable after the first unlock (so background runs work
/// while the phone is locked) and never synced off this device.
public struct KeychainMarketplaceSessionStore: MarketplaceSessionStore {
    private let service: String

    public init(service: String = "com.listora.app.marketplace-sessions") {
        self.service = service
    }

    public func cookies(for marketplace: String) -> [StoredCookie] {
        var query = query(marketplace)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else {
            return []
        }
        return (try? JSONDecoder().decode([StoredCookie].self, from: data)) ?? []
    }

    public func save(_ cookies: [StoredCookie], for marketplace: String) {
        SecItemDelete(query(marketplace) as CFDictionary)
        guard !cookies.isEmpty, let data = try? JSONEncoder().encode(cookies) else { return }
        var item = query(marketplace)
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    public func keep(onlyFor account: String) {
        let owner = ownerQuery
        var read = owner
        read[kSecReturnData as String] = true
        read[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let stored = SecItemCopyMatching(read as CFDictionary, &result) == errSecSuccess
            ? (result as? Data).flatMap { String(data: $0, encoding: .utf8) }
            : nil
        guard stored != account else { return }
        removeAll()
        SecItemDelete(owner as CFDictionary)
        var item = owner
        item[kSecValueData as String] = Data(account.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    public func removeAll() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ] as CFDictionary)
    }

    private func query(_ marketplace: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: marketplace,
        ]
    }

    /// The account the sessions belong to, kept beside them.
    private var ownerQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "\(service).owner",
            kSecAttrAccount as String: "account",
        ]
    }
}

/// The sessions in memory only: for tests and previews.
public final class InMemoryMarketplaceSessionStore: MarketplaceSessionStore {
    private let sessions: Mutex<[String: [StoredCookie]]>
    private let owner = Mutex<String?>(nil)

    public init(_ sessions: [String: [StoredCookie]] = [:]) {
        self.sessions = Mutex(sessions)
    }

    public func keep(onlyFor account: String) {
        let changed = owner.withLock { owner in
            defer { owner = account }
            return owner != account
        }
        if changed {
            removeAll()
        }
    }

    public func removeAll() {
        sessions.withLock { $0 = [:] }
    }

    public func cookies(for marketplace: String) -> [StoredCookie] {
        sessions.withLock { $0[marketplace] ?? [] }
    }

    public func save(_ cookies: [StoredCookie], for marketplace: String) {
        sessions.withLock { $0[marketplace] = cookies.isEmpty ? nil : cookies }
    }
}
