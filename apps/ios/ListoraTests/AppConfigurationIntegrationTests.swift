import APIClient
import AppFeature
import Core
import Foundation
import Testing

/// Runs inside the Dev app, so `Bundle.main` is the real app bundle built from project.yml and
/// Config/Dev.xcconfig.
@MainActor
struct AppConfigurationIntegrationTests {
    @Test
    func `the Dev build is configured for the local API`() throws {
        let dependencies = try AppDependencies(bundle: .main)
        #expect(dependencies.configuration.environment == .dev)
        let url = dependencies.configuration.apiBaseURL
        #expect(url.scheme == "http")
        #expect(dependencies.apiClient.baseURL == url)
    }

    @Test
    func `the Dev build allows plain HTTP to local addresses`() throws {
        let ats = try #require(Bundle.main.object(forInfoDictionaryKey: "NSAppTransportSecurity") as? [String: Any])
        #expect(ats["NSAllowsLocalNetworking"] as? Bool == true)
    }

    @Test
    func `the app bundle carries a version and build number`() throws {
        let dependencies = try AppDependencies(bundle: .main)
        #expect(dependencies.version.marketing != "?")
        #expect(dependencies.version.build != "?")
    }

    @Test
    func `the app bundle has the AppIcon icon`() throws {
        let icons = try #require(Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons") as? [String: Any])
        let primary = try #require(icons["CFBundlePrimaryIcon"] as? [String: Any])
        #expect(primary["CFBundleIconName"] as? String == "AppIcon")
        let assets = try #require(Bundle.main.url(forResource: "Assets", withExtension: "car"))
        #expect(FileManager.default.fileExists(atPath: assets.path))
    }

    @Test
    func `the Share Extension has the same AppIcon icon`() throws {
        let plugIns = try #require(Bundle.main.builtInPlugInsURL)
        let extensionBundle = try #require(Bundle(url: plugIns.appending(path: "ShareExtension.appex")))
        let icons = try #require(extensionBundle.object(forInfoDictionaryKey: "CFBundleIcons") as? [String: Any])
        let primary = try #require(icons["CFBundlePrimaryIcon"] as? [String: Any])
        #expect(primary["CFBundleIconName"] as? String == "AppIcon")
        #expect(extensionBundle.url(forResource: "Assets", withExtension: "car") != nil)
    }
}

/// Runs inside the app, which has the Keychain entitlement the package tests lack.
struct KeychainAccessGrantStorageTests {
    @Test
    func `keeps the session in the Keychain across instances and removes it on sign-out`() {
        let service = "com.listora.tests.\(UUID().uuidString)"
        let grant = AccessGrant(
            accessToken: "token-1",
            expiresAt: Date(timeIntervalSince1970: 2_000_000_000),
            email: "a@b.c",
        )
        defer { KeychainAccessGrantStorage(service: service).save(nil) }

        KeychainAccessGrantStorage(service: service).save(grant)
        #expect(KeychainAccessGrantStorage(service: service).load() == grant)

        KeychainAccessGrantStorage(service: service).save(nil)
        #expect(KeychainAccessGrantStorage(service: service).load() == nil)
    }
}
