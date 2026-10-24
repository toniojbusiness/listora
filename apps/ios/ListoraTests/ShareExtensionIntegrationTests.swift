import APIClient
import AppFeature
import Core
import Foundation
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
}
