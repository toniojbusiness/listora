import Foundation
import Security
import Synchronization

/// Supplies the bearer token for API requests.
public protocol AccessTokenProvider: Sendable {
    /// The current token, or nil when nobody is signed in or the session has expired.
    func accessToken() async -> String?
    /// The server answered `401` to a request carrying `token`: it is no longer valid.
    func reject(_ token: String) async
}

/// A signed-in session: the API's bearer token and when it stops working.
public struct AccessGrant: Codable, Equatable, Sendable {
    public let accessToken: String
    public let expiresAt: Date
    /// Who signed in, for display.
    public let email: String
    /// Renews `accessToken` when it expires (a Cognito refresh token, valid for 30 days); nil for
    /// a session that simply ends (the dev driver's). A session saved before it existed reads nil.
    public let refreshToken: String?

    public init(accessToken: String, expiresAt: Date, email: String, refreshToken: String? = nil) {
        self.accessToken = accessToken
        self.expiresAt = expiresAt
        self.email = email
        self.refreshToken = refreshToken
    }

    /// Who signed in, as the API knows them: the token's issuer and subject (the identity the
    /// server finds the account by, `app_user.auth_subject`), which stays the same across
    /// renewals. Never the email, which another account can come to use. Nil for a token that
    /// is not a JWT with both.
    public var identity: String? {
        let parts = accessToken.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        var payload = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload),
              let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let issuer = claims["iss"] as? String, !issuer.isEmpty,
              let subject = claims["sub"] as? String, !subject.isEmpty
        else {
            return nil
        }
        return "\(issuer)#\(subject)"
    }
}

/// Renews a session whose token is about to expire, with its refresh token.
public protocol AccessGrantRefresher: Sendable {
    /// The renewed session. A failure whose `isUnauthenticated` is true means the refresh token no
    /// longer works (revoked, expired, or its user deleted): the person has to sign in again. Any
    /// other failure (no connection) leaves the session as it is, to try again later.
    func refresh(_ grant: AccessGrant) async throws(APIFailure) -> AccessGrant
}

/// Where the signed-in session is kept between launches.
public protocol AccessGrantStorage: Sendable {
    func load() -> AccessGrant?
    func save(_ grant: AccessGrant?)
}

/// The app's signed-in session. It is kept in ``AccessGrantStorage`` (the Keychain in the app),
/// cached in memory, and dropped when it expires or the server rejects it. Observers of
/// ``changes()`` hear about every sign-in and sign-out, so work waiting for a session resumes.
///
/// With a ``AccessGrantRefresher``, a session with a refresh token outlives its token: the token
/// is renewed shortly before it expires, by one refresh at a time however many requests wait for
/// it, and the session ends only when the refresher says the refresh token no longer works.
public final class AccessTokenStore: AccessTokenProvider {
    private struct State {
        var grant: AccessGrant?
        var observers: [UUID: AsyncStream<AccessGrant?>.Continuation] = [:]
        /// The refresh in flight, which every caller of ``accessToken()`` meanwhile awaits.
        var refreshing: Task<String?, Never>?
    }

    /// A refreshable token is renewed this long before it expires, so no request carries a token
    /// that expires on its way.
    public static let refreshMargin: TimeInterval = 5 * 60

    private let storage: any AccessGrantStorage
    private let refresher: (any AccessGrantRefresher)?
    private let now: @Sendable () -> Date
    private let state: Mutex<State>

    public init(
        storage: any AccessGrantStorage,
        refresher: (any AccessGrantRefresher)? = nil,
        now: @escaping @Sendable () -> Date = Date.init,
    ) {
        self.storage = storage
        self.refresher = refresher
        self.now = now
        state = Mutex(State(grant: storage.load()))
    }

    /// The session, or nil when signed out, or expired with no way to renew it.
    public var grant: AccessGrant? {
        let now = now()
        return state.withLock { state in
            guard let grant = state.grant, grant.expiresAt > now || canRefresh(grant) else { return nil }
            return grant
        }
    }

    public func accessToken() async -> String? {
        let soon = now().addingTimeInterval(Self.refreshMargin)
        let (current, refresh): (AccessGrant?, Task<String?, Never>?) = state.withLock { state in
            guard let grant = state.grant else { return (nil, nil) }
            guard let refresher, grant.refreshToken != nil, grant.expiresAt <= soon else { return (grant, nil) }
            if let running = state.refreshing {
                return (grant, running)
            }
            // Set under the lock that the task's own cleanup takes, so it can never clear it first.
            let task = Task { await self.renew(grant, with: refresher) }
            state.refreshing = task
            return (grant, task)
        }
        if let refresh {
            return await refresh.value
        }
        guard let current, current.expiresAt > now() else { return nil }
        return current.accessToken
    }

    private func canRefresh(_ grant: AccessGrant) -> Bool {
        refresher != nil && grant.refreshToken != nil
    }

    /// Renews `grant` and returns the token to send, or nil when there is none.
    private func renew(_ grant: AccessGrant, with refresher: any AccessGrantRefresher) async -> String? {
        defer { state.withLock { $0.refreshing = nil } }
        do {
            let renewed = try await refresher.refresh(grant)
            // A sign-out or another sign-in while the refresh ran wins over it.
            var replaced = false
            update { current in
                guard current == grant else { return current }
                replaced = true
                return renewed
            }
            return replaced ? renewed.accessToken : nil
        } catch {
            if error.isUnauthenticated {
                update { $0 == grant ? nil : $0 }
                return nil
            }
            // Not reachable now: the old token still works until it expires; then nothing does.
            return grant.expiresAt > now() ? grant.accessToken : nil
        }
    }

    public func reject(_ token: String) async {
        update { $0?.accessToken == token ? nil : $0 }
    }

    public func signIn(_ grant: AccessGrant) {
        update { _ in grant }
    }

    public func signOut() {
        update { _ in nil }
    }

    /// The current session, then every change to it.
    public func changes() -> AsyncStream<AccessGrant?> {
        let (stream, continuation) = AsyncStream.makeStream(of: AccessGrant?.self, bufferingPolicy: .bufferingNewest(1))
        let id = UUID()
        continuation.onTermination = { [weak self] _ in
            self?.state.withLock { _ = $0.observers.removeValue(forKey: id) }
        }
        let current = grant
        state.withLock { $0.observers[id] = continuation }
        continuation.yield(current)
        return stream
    }

    private func update(_ change: (AccessGrant?) -> AccessGrant?) {
        let (changed, grant, observers) = state.withLock { state in
            let next = change(state.grant)
            let changed = next != state.grant
            state.grant = next
            return (changed, next, Array(state.observers.values))
        }
        guard changed else { return }
        storage.save(grant)
        for observer in observers {
            observer.yield(grant)
        }
    }
}

/// Keeps the session in the Keychain, readable after the first unlock so background uploads keep
/// working while the phone is locked, and never synced off this device.
public struct KeychainAccessGrantStorage: AccessGrantStorage {
    private let service: String
    private let accessGroup: String?
    private let account = "access-grant"

    /// - Parameter accessGroup: The keychain access group to keep the item in; nil for the app's
    ///   own default group.
    public init(service: String, accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    /// The signed-in session the app and its Share Extension share, in an access group both are
    /// entitled to (`AppConfiguration.sessionKeychainGroup`), so signing in to the app signs the
    /// extension in. An App Group identifier works as one for every target with the group's
    /// entitlement; so does a team-prefixed keychain-access-groups entry.
    public static func session(accessGroup: String) -> Self {
        Self(service: "com.listora.app.session", accessGroup: accessGroup)
    }

    /// Reads the session. With an access group, a session that an earlier build saved under the
    /// same service in the app's default group is moved into the access group the first time.
    public func load() -> AccessGrant? {
        if let data = copyData(baseQuery) {
            return try? JSONDecoder().decode(AccessGrant.self, from: data)
        }
        for group in legacyAccessGroups() {
            let legacy = query(accessGroup: group)
            guard let data = copyData(legacy) else { continue }
            guard let grant = try? JSONDecoder().decode(AccessGrant.self, from: data) else {
                SecItemDelete(legacy as CFDictionary)
                return nil
            }
            if write(grant) {
                SecItemDelete(legacy as CFDictionary)
            }
            return grant
        }
        return nil
    }

    /// Saves the session, or with nil signs out: that also removes any session an earlier build
    /// left in the app's default group.
    public func save(_ grant: AccessGrant?) {
        guard let grant else {
            SecItemDelete(baseQuery as CFDictionary)
            for group in legacyAccessGroups() {
                SecItemDelete(query(accessGroup: group) as CFDictionary)
            }
            return
        }
        write(grant)
    }

    @discardableResult
    private func write(_ grant: AccessGrant) -> Bool {
        SecItemDelete(baseQuery as CFDictionary)
        guard let data = try? JSONEncoder().encode(grant) else { return false }
        var item = baseQuery
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    private func copyData(_ query: [String: Any]) -> Data? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    /// The other groups holding an item for this service and account. A query without an access
    /// group searches every group the process can read, so this finds the item an earlier build
    /// saved in the app's default group.
    private func legacyAccessGroups() -> [String] {
        guard let accessGroup else { return [] }
        var search = query(accessGroup: nil)
        search[kSecReturnAttributes as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitAll
        var result: CFTypeRef?
        guard SecItemCopyMatching(search as CFDictionary, &result) == errSecSuccess,
              let items = result as? [[String: Any]]
        else {
            return []
        }
        return items.compactMap { $0[kSecAttrAccessGroup as String] as? String }.filter { $0 != accessGroup }
    }

    private var baseQuery: [String: Any] {
        query(accessGroup: accessGroup)
    }

    private func query(accessGroup: String?) -> [String: Any] {
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

/// Keeps the session in memory only: for tests and previews.
public final class InMemoryAccessGrantStorage: AccessGrantStorage {
    private let grant: Mutex<AccessGrant?>

    public init(_ grant: AccessGrant? = nil) {
        self.grant = Mutex(grant)
    }

    public func load() -> AccessGrant? {
        grant.withLock { $0 }
    }

    public func save(_ grant: AccessGrant?) {
        self.grant.withLock { $0 = grant }
    }
}
