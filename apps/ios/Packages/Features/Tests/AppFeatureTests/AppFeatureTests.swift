import AppFeature
import Core
import Foundation
import Testing

struct AppTabTests {
    @Test
    func `the tab bar shows Inventory, Add Item, Tasks, Settings in that order`() {
        #expect(AppTab.allCases.map(\.title) == ["Inventory", "Add Item", "Tasks", "Settings"])
    }

    @Test
    func `every tab has a distinct icon`() {
        let icons = AppTab.allCases.map(\.systemImage)
        #expect(Set(icons).count == icons.count)
        #expect(!icons.contains(""))
    }
}

struct AppDependenciesTests {
    @Test
    func `builds the API client from the configured base URL`() throws {
        let info: [String: Any] = [
            AppConfiguration.InfoKey.environment: "staging",
            AppConfiguration.InfoKey.apiBaseURL: "https://api.staging.example.com",
            "CFBundleShortVersionString": "1.0",
            "CFBundleVersion": "3",
        ]
        let bundle = try InfoBundle(info)
        let dependencies = try AppDependencies(bundle: bundle.bundle)
        #expect(dependencies.configuration.environment == .staging)
        #expect(dependencies.apiClient.baseURL.absoluteString == "https://api.staging.example.com")
        #expect(dependencies.version.description == "1.0 (3)")
    }

    @Test
    func `a bundle without configuration fails instead of falling back to a default`() throws {
        let bundle = try InfoBundle([:])
        #expect(throws: ConfigurationError.missing(key: AppConfiguration.InfoKey.environment)) {
            try AppDependencies(bundle: bundle.bundle)
        }
    }
}

/// A throwaway on-disk bundle with the given Info.plist, removed when the test ends.
private final class InfoBundle {
    let url: URL
    let bundle: Bundle

    init(_ info: [String: Any]) throws {
        url = FileManager.default.temporaryDirectory
            .appending(path: "InfoBundle-\(UUID().uuidString).bundle", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        let data = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        try data.write(to: url.appending(path: "Info.plist"))
        bundle = try #require(Bundle(url: url))
    }

    deinit {
        try? FileManager.default.removeItem(at: url)
    }
}
