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

    public init(accessToken: String, expiresAt: Date, email: String) {
        self.accessToken = accessToken
        self.expiresAt = expiresAt
        self.email = email
    }
}

/// Where the signed-in session is kept between launches.
public protocol AccessGrantStorage: Sendable {
    func load() -> AccessGrant?
    func save(_ grant: AccessGrant?)
}

/// The app's signed-in session. It is kept in ``AccessGrantStorage`` (the Keychain in the app),
/// cached in memory, and dropped when it expires or the server rejects it. Observers of
/// ``changes()`` hear about every sign-in and sign-out, so work waiting for a session resumes.
public final class AccessTokenStore: AccessTokenProvider {
    private struct State {
        var grant: AccessGrant?
        var observers: [UUID: AsyncStream<AccessGrant?>.Continuation] = [:]
    }

    private let storage: any AccessGrantStorage
    private let now: @Sendable () -> Date
    private let state: Mutex<State>

    public init(storage: any AccessGrantStorage, now: @escaping @Sendable () -> Date = Date.init) {
        self.storage = storage
        self.now = now
        state = Mutex(State(grant: storage.load()))
    }

    /// The session, or nil when signed out or expired.
    public var grant: AccessGrant? {
        let now = now()
        return state.withLock { state in
            guard let grant = state.grant, grant.expiresAt > now else { return nil }
            return grant
        }
    }

    public func accessToken() async -> String? {
        grant?.accessToken
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

    /// The signed-in session the app and its Share Extension share. An App Group identifier works
    /// as a keychain access group for every target with the group's entitlement, without a
    /// team-prefixed keychain-access-groups entry, so signing in to the app signs the extension in.
    public static func session(appGroup: String) -> Self {
        Self(service: "com.listora.app.session", accessGroup: appGroup)
    }

    public func load() -> AccessGrant? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return try? JSONDecoder().decode(AccessGrant.self, from: data)
    }

    public func save(_ grant: AccessGrant?) {
        SecItemDelete(baseQuery as CFDictionary)
        guard let grant, let data = try? JSONEncoder().encode(grant) else { return }
        var item = baseQuery
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    private var baseQuery: [String: Any] {
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
