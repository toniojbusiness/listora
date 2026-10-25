import APIClient
import AppFeature
import Core
import Foundation
import Security
import Testing

/// Runs inside the Dev app with its real entitlements, so it checks what the Share Extension
/// relies on: the same configuration, and the session in the App Group keychain.
struct ShareExtensionIntegrationTests {
    private func extensionInfo() throws -> [String: Any] {
        let plugIns = try #require(Bundle.main.builtInPlugInsURL)
        let bundle = try #require(Bundle(url: plugIns.appending(path: "ShareExtension.appex")))
        return bundle.infoDictionary ?? [:]
    }

    @Test
    func `the extension is configured like the app and shares its App Group`() throws {
        let app = try AppConfiguration(bundle: .main)
        let shared = try AppConfiguration(infoDictionary: extensionInfo())
        #expect(shared == app)
        #expect(app.appGroupIdentifier == "group.com.listora.app.dev")
    }

    @Test
    func `the extension accepts a shared web URL or text`() throws {
        let info = try extensionInfo()
        let rule = try #require(
            ((info["NSExtension"] as? [String: Any])?["NSExtensionAttributes"] as? [String: Any])?[
                "NSExtensionActivationRule",
            ] as? [String: Any],
        )
        #expect(rule["NSExtensionActivationSupportsWebURLWithMaxCount"] as? Int == 1)
        #expect(rule["NSExtensionActivationSupportsText"] as? Bool == true)
        // Dev reaches the local API over plain HTTP, like the app.
        let ats = try #require(info["NSAppTransportSecurity"] as? [String: Any])
        #expect(ats["NSAllowsLocalNetworking"] as? Bool == true)
    }

    @Test
    func `a session saved in the App Group keychain is readable by a second store`() throws {
        let group = try AppConfiguration(bundle: .main).appGroupIdentifier
        let service = "com.listora.tests.\(UUID().uuidString)"
        let grant = AccessGrant(accessToken: "token-1", expiresAt: .distantFuture, email: "a@b.c")
        defer { KeychainAccessGrantStorage(service: service, accessGroup: group).save(nil) }

        KeychainAccessGrantStorage(service: service, accessGroup: group).save(grant)
        // A second storage, as the extension builds it, reads the same item.
        #expect(KeychainAccessGrantStorage(service: service, accessGroup: group).load() == grant)
        KeychainAccessGrantStorage(service: service, accessGroup: group).save(nil)
        #expect(KeychainAccessGrantStorage(service: service, accessGroup: group).load() == nil)
    }

    @Test
    func `a session an earlier build saved outside the App Group moves into it once`() throws {
        let group = try AppConfiguration(bundle: .main).appGroupIdentifier
        let service = "com.listora.tests.\(UUID().uuidString)"
        let grant = AccessGrant(accessToken: "token-1", expiresAt: .distantFuture, email: "a@b.c")
        defer { KeychainAccessGrantStorage(service: service, accessGroup: group).save(nil) }

        // Earlier builds kept the session in the app's default group.
        KeychainAccessGrantStorage(service: service).save(grant)
        try #require(accessGroups(holding: service).count == 1)
        #expect(try !accessGroups(holding: service).contains(group))

        #expect(KeychainAccessGrantStorage(service: service, accessGroup: group).load() == grant)
        #expect(try accessGroups(holding: service) == [group])
        #expect(KeychainAccessGrantStorage(service: service, accessGroup: group).load() == grant)
    }

    @Test
    func `signing out removes the session from the App Group and from the earlier location`() throws {
        let group = try AppConfiguration(bundle: .main).appGroupIdentifier
        let service = "com.listora.tests.\(UUID().uuidString)"
        let grant = AccessGrant(accessToken: "token-1", expiresAt: .distantFuture, email: "a@b.c")
        let storage = KeychainAccessGrantStorage(service: service, accessGroup: group)
        defer { storage.save(nil) }

        KeychainAccessGrantStorage(service: service).save(grant)
        storage.save(AccessGrant(accessToken: "token-2", expiresAt: .distantFuture, email: "a@b.c"))
        try #require(accessGroups(holding: service).count == 2)

        storage.save(nil)
        #expect(try accessGroups(holding: service).isEmpty)
        #expect(storage.load() == nil)
    }

    /// Every access group with a session item for `service`, whichever store saved it.
    private func accessGroups(holding service: String) throws -> [String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return []
        }
        try #require(status == errSecSuccess)
        let items = try #require(result as? [[String: Any]])
        return items.compactMap { $0[kSecAttrAccessGroup as String] as? String }
    }
}
