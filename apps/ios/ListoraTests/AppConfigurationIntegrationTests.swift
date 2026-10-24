import AppFeature
import Core
import Foundation
import Testing

/// Runs inside the Dev app, so `Bundle.main` is the real app bundle built from project.yml and
/// Config/Dev.xcconfig.
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
}
