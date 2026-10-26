import APIClient
import AppFeature
import Core
import Foundation
import SettingsFeature
import Testing

struct AppTabTests {
    @Test
    func `the tab bar shows Today, Inventory, Add, Tasks, Sales: five, with Add in the center`() {
        #expect(AppTab.allCases.map(\.title) == ["Today", "Inventory", "Add", "Tasks", "Sales"])
    }

    @Test
    func `every tab has a distinct icon`() {
        let icons = AppTab.allCases.map(\.systemImage)
        #expect(Set(icons).count == icons.count)
        #expect(!icons.contains(""))
    }
}

@MainActor
struct AppDependenciesTests {
    private let data = FileManager.default.temporaryDirectory
        .appending(path: "AppDependenciesTests-\(UUID().uuidString)")
    private let listingCopy = FileManager.default.temporaryDirectory
        .appending(path: "AppDependenciesTests-copy-\(UUID().uuidString)")
    private let defaults = UserDefaults(suiteName: "AppDependenciesTests-\(UUID().uuidString)") ?? .standard

    private func dependencies(
        environment: String = "staging",
        url: String = "https://api.staging.example.com",
        storage: InMemoryAccessGrantStorage = InMemoryAccessGrantStorage(),
        launchOptions: DebugLaunchOptions = .none,
        cognitoClientID: String = "",
    ) throws -> AppDependencies {
        let bundle = try InfoBundle([
            AppConfiguration.InfoKey.environment: environment,
            AppConfiguration.InfoKey.apiBaseURL: url,
            AppConfiguration.InfoKey.appGroup: "group.com.listora.app.staging",
            AppConfiguration.InfoKey.sessionKeychainGroup: "group.com.listora.app.staging",
            AppConfiguration.InfoKey.cognitoRegion: "us-east-1",
            AppConfiguration.InfoKey.cognitoClientID: cognitoClientID,
            "CFBundleShortVersionString": "1.0",
            "CFBundleVersion": "3",
        ])
        return try AppDependencies(
            bundle: bundle.bundle,
            dataDirectory: data,
            listingCopyDirectory: listingCopy,
            defaults: defaults,
            accessGrantStorage: storage,
            launchOptions: launchOptions,
        )
    }

    @Test
    func `builds the API client from the configured base URL`() throws {
        let dependencies = try dependencies()
        #expect(dependencies.configuration.environment == .staging)
        #expect(dependencies.apiClient.baseURL.absoluteString == "https://api.staging.example.com")
        #expect(dependencies.configuration.appGroupIdentifier == "group.com.listora.app.staging")
        #expect(dependencies.version.description == "1.0 (3)")
    }

    @Test
    func `a bundle without configuration fails instead of falling back to a default`() throws {
        let bundle = try InfoBundle([:])
        #expect(throws: ConfigurationError.missing(key: AppConfiguration.InfoKey.environment)) {
            try AppDependencies(
                bundle: bundle.bundle,
                dataDirectory: data,
                accessGrantStorage: InMemoryAccessGrantStorage(),
            )
        }
    }

    @Test
    func `dev builds sign in with the developer sign-in, others with their user pool or not at all`() throws {
        #expect(try dependencies(environment: "dev", url: "http://127.0.0.1:3000").signIn.kind == .developer)
        #expect(try dependencies(cognitoClientID: "4example5client6id7abcdefgh").signIn.kind == .emailCode)
        let unconfigured = try dependencies()
        #expect(unconfigured.signIn.kind == nil)
        #expect(unconfigured.signIn.stage == .unavailable)
    }

    @Test
    func `a Cognito build renews an expired session instead of signing it out`() throws {
        let expired = AccessGrant(accessToken: "t", expiresAt: .distantPast, email: "a@b.c", refreshToken: "r")
        let refreshable = try dependencies(
            storage: InMemoryAccessGrantStorage(expired), cognitoClientID: "4example5client6id7abcdefgh",
        )
        #expect(refreshable.accessTokens.grant == expired)
        #expect(try dependencies(storage: InMemoryAccessGrantStorage(expired)).accessTokens.grant == nil)
    }

    @Test
    func `the reset launch option starts with no drafts and signed out`() throws {
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        try Data("old".utf8).write(to: data.appending(path: "leftover"))
        let grant = AccessGrant(accessToken: "t", expiresAt: .distantFuture, email: "a@b.c")
        let storage = InMemoryAccessGrantStorage(grant)

        let dependencies = try dependencies(storage: storage, launchOptions: DebugLaunchOptions(resetLocalData: true))

        #expect(dependencies.accessTokens.grant == nil)
        #expect(!FileManager.default.fileExists(atPath: data.appending(path: "leftover").path(percentEncoded: false)))
        try? FileManager.default.removeItem(at: data)
    }

    @Test
    func `debug launch options point Dev at the UI tests' API and start signed in`() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let options = DebugLaunchOptions.from(
            environment: [
                "LISTORA_DEV_API_BASE_URL": "http://127.0.0.1:53111",
                "LISTORA_DEV_ACCESS_TOKEN": "token-1",
                "LISTORA_DEV_ACCESS_EMAIL": "e2e@listora.test",
            ],
            now: now,
        )
        #expect(options.apiBaseURL?.absoluteString == "http://127.0.0.1:53111")
        #expect(options.accessGrant == AccessGrant(
            accessToken: "token-1",
            expiresAt: now.addingTimeInterval(86400),
            email: "e2e@listora.test",
        ))
        #expect(DebugLaunchOptions.from(environment: [:]) == .none)

        let storage = InMemoryAccessGrantStorage()
        let dependencies = try dependencies(
            environment: "dev",
            url: "http://127.0.0.1:3000",
            storage: storage,
            launchOptions: DebugLaunchOptions(
                resetLocalData: true,
                apiBaseURL: options.apiBaseURL,
                accessGrant: AccessGrant(accessToken: "token-1", expiresAt: .distantFuture, email: "e2e@listora.test"),
            ),
        )
        #expect(dependencies.apiClient.baseURL.absoluteString == "http://127.0.0.1:53111")
        #expect(dependencies.configuration.apiBaseURL.absoluteString == "http://127.0.0.1:53111")
        #expect(dependencies.accessTokens.grant?.accessToken == "token-1", "signed in after the reset")
    }

    @Test
    func `an API override is held to the environment's rules`() throws {
        let dependencies = try dependencies(launchOptions: DebugLaunchOptions(
            apiBaseURL: URL(string: "http://127.0.0.1:53111"),
        ))
        #expect(dependencies.apiClient.baseURL.absoluteString == "https://api.staging.example.com")
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
