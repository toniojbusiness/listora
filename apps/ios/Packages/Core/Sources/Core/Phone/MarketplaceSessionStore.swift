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
/// The sessions belong to one Listora account, named by its sign-in identity
/// (`AccessGrant.identity`), never its email: signing in to another account on this phone removes
/// them (`keep(onlyFor:formerly:)`), so one account's runs never act in another seller's sessions,
/// and so does signing out (`removeAll`).
///
/// It also keeps which of the account's marketplaces this phone holds read only
/// (docs/features/read-only.md#on-the-phone): the phone refuses a write there itself, whatever a
/// call says. A mark stays through a sign-out and goes only when the seller turns Read only off
/// on this phone, or another account signs in.
public protocol MarketplaceSessionStore: Sendable {
    func cookies(for marketplace: String) -> [StoredCookie]
    func save(_ cookies: [StoredCookie], for marketplace: String)
    /// The account signed in now: the sessions and read-only marks of any other account are
    /// removed. `legacy` is the owner an earlier build recorded for the same account (its email),
    /// whose sessions stay.
    func keep(onlyFor account: String, formerly legacy: String?)
    /// Removes every session (signing out); the read-only marks stay.
    func removeAll()
    /// Whether this phone holds the account on `marketplace` read only.
    func isReadOnly(_ marketplace: String) -> Bool
    func setReadOnly(_ readOnly: Bool, for marketplace: String)
}

/// The sessions in the Keychain, readable after the first unlock (so background runs work
/// while the phone is locked) and never synced off this device.
///
/// With an access group (`AppConfiguration.phoneKeychainGroup`) every item is kept in it: the
/// app's own group, never the one the Share Extension shares. Without one the items go to the
/// app's default group, which is its own in every committed configuration (the app has no
/// keychain-access-groups entitlement there).
public struct KeychainMarketplaceSessionStore: MarketplaceSessionStore {
    private let service: String
    private let accessGroup: String?

    public init(service: String = "com.listora.app.marketplace-sessions", accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private var ownerService: String {
        "\(service).owner"
    }

    private var readOnlyService: String {
        "\(service).read-only"
    }

    public func cookies(for marketplace: String) -> [StoredCookie] {
        guard let data = copyData(query(service, marketplace)) else { return [] }
        return (try? JSONDecoder().decode([StoredCookie].self, from: data)) ?? []
    }

    public func save(_ cookies: [StoredCookie], for marketplace: String) {
        guard !cookies.isEmpty, let data = try? JSONEncoder().encode(cookies) else {
            delete(service, marketplace)
            return
        }
        write(data, service, marketplace)
    }

    public func keep(onlyFor account: String, formerly legacy: String?) {
        let stored = copyData(query(ownerService, "account")).flatMap { String(data: $0, encoding: .utf8) }
        guard stored != account else { return }
        if stored == nil || stored != legacy {
            removeAll()
            delete(readOnlyService, nil)
        }
        write(Data(account.utf8), ownerService, "account")
    }

    public func removeAll() {
        delete(service, nil)
    }

    /// Removes everything it keeps, the account and its read-only marks too: the phone as newly
    /// installed (`LISTORA_RESET_LOCAL_DATA`).
    public func reset() {
        for name in [service, ownerService, readOnlyService] {
            delete(name, nil)
        }
    }

    /// False when the Keychain can't be read (before the first unlock): the server's own refusals
    /// still stand.
    public func isReadOnly(_ marketplace: String) -> Bool {
        copyData(query(readOnlyService, marketplace)) != nil
    }

    public func setReadOnly(_ readOnly: Bool, for marketplace: String) {
        if readOnly {
            write(Data("read-only".utf8), readOnlyService, marketplace)
        } else {
            delete(readOnlyService, marketplace)
        }
    }

    /// Moves the items an earlier build kept in another group into the access group: one with
    /// no group of its own landed in the app's default group, which in a personal device build was
    /// the group the Share Extension shares. Call it once at launch, before the first read.
    public func moveIntoAccessGroup() {
        guard let accessGroup else { return }
        for name in [service, ownerService, readOnlyService] {
            // A query without an access group searches every group the app can read.
            let search: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: name,
                kSecReturnAttributes as String: true,
                kSecMatchLimit as String: kSecMatchLimitAll,
            ]
            var result: CFTypeRef?
            guard SecItemCopyMatching(search as CFDictionary, &result) == errSecSuccess,
                  let items = result as? [[String: Any]]
            else { continue }
            for item in items {
                guard let group = item[kSecAttrAccessGroup as String] as? String, group != accessGroup,
                      let account = item[kSecAttrAccount as String] as? String
                else { continue }
                let legacy: [String: Any] = [
                    kSecClass as String: kSecClassGenericPassword,
                    kSecAttrService as String: name,
                    kSecAttrAccount as String: account,
                    kSecAttrAccessGroup as String: group,
                ]
                guard let data = copyData(legacy) else { continue }
                var moved = query(name, account)
                SecItemDelete(moved as CFDictionary)
                moved[kSecValueData as String] = data
                moved[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                // The old one goes only once the new one is kept.
                if SecItemAdd(moved as CFDictionary, nil) == errSecSuccess {
                    SecItemDelete(legacy as CFDictionary)
                }
            }
        }
    }

    /// Replaces the item: an earlier one in any group goes, and the new one is kept in the access
    /// group.
    private func write(_ data: Data, _ service: String, _ account: String) {
        delete(service, account)
        var item = query(service, account)
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    /// Deletes the item (or, for a nil account, every item of the service) in every group the app
    /// can read, so nothing an earlier build kept elsewhere stays behind.
    private func delete(_ service: String, _ account: String?) {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        if let account {
            query[kSecAttrAccount as String] = account
        }
        SecItemDelete(query as CFDictionary)
    }

    private func copyData(_ query: [String: Any]) -> Data? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    private func query(_ service: String, _ account: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
            query[kSecUseDataProtectionKeychain as String] = true
        }
        return query
    }
}

/// The sessions in memory only: for tests and previews.
public final class InMemoryMarketplaceSessionStore: MarketplaceSessionStore {
    private let sessions: Mutex<[String: [StoredCookie]]>
    private let owner: Mutex<String?>
    private let readOnly = Mutex<Set<String>>([])

    public init(_ sessions: [String: [StoredCookie]] = [:], owner: String? = nil) {
        self.sessions = Mutex(sessions)
        self.owner = Mutex(owner)
    }

    public func keep(onlyFor account: String, formerly legacy: String?) {
        let changed = owner.withLock { owner in
            defer { owner = account }
            return owner != account && (owner == nil || owner != legacy)
        }
        if changed {
            removeAll()
            readOnly.withLock { $0 = [] }
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

    public func isReadOnly(_ marketplace: String) -> Bool {
        readOnly.withLock { $0.contains(marketplace) }
    }

    public func setReadOnly(_ readOnly: Bool, for marketplace: String) {
        self.readOnly.withLock { marks in
            if readOnly {
                marks.insert(marketplace)
            } else {
                marks.remove(marketplace)
            }
        }
    }
}
