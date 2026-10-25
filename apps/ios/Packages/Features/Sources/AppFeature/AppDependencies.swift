import AddItemFeature
import APIClient
import Core
import Foundation
import MarketplacesFeature
import SettingsFeature
import TagReadingFeature

/// Everything the app's features need, built once at launch.
@MainActor
public struct AppDependencies {
    public let configuration: AppConfiguration
    public let version: AppVersion
    /// The signed-in session, kept in the App Group's keychain access group, where the Share
    /// Extension reads it too.
    public let accessTokens: AccessTokenStore
    public let apiClient: APIClient
    /// Reads text and barcodes on tag photos on the device, for the capture flow to upload.
    public let tagReader: any TagReader
    /// Drafts and the photo upload queue.
    public let addItem: AddItemEnvironment
    /// Dev builds only: sign in against the local API's dev auth driver.
    public let devSignIn: DevSignInModel?
    /// The Marketplaces screen (in Settings): connection status and connecting eBay.
    public let marketplaces: MarketplacesModel

    public init(
        configuration: AppConfiguration,
        version: AppVersion,
        dataDirectory: URL = AddItemEnvironment.defaultDataDirectory(),
        accessGrantStorage: (any AccessGrantStorage)? = nil,
        launchOptions: DebugLaunchOptions = .none,
    ) {
        #if DEBUG
            DevOverrides.storeAPIBaseURL(launchOptions.apiBaseURL, for: configuration)
            let configuration = DevOverrides.applied(to: configuration)
        #endif
        self.configuration = configuration
        self.version = version
        let accessGrantStorage = accessGrantStorage
            ?? KeychainAccessGrantStorage.session(appGroup: configuration.appGroupIdentifier)
        if launchOptions.resetLocalData {
            try? FileManager.default.removeItem(at: dataDirectory)
            accessGrantStorage.save(nil)
        }
        let accessTokens = AccessTokenStore(storage: accessGrantStorage)
        if let token = launchOptions.accessToken, configuration.environment == .dev {
            accessTokens.signIn(AccessGrant(
                accessToken: token,
                expiresAt: .distantFuture,
                email: "ui-test@listora.invalid",
            ))
        }
        self.accessTokens = accessTokens
        apiClient = APIClient(baseURL: configuration.apiBaseURL, accessTokens: accessTokens)
        let tagReader = VisionTagReader()
        self.tagReader = tagReader
        addItem = AddItemEnvironment(
            dataDirectory: dataDirectory,
            apiClient: apiClient,
            accessTokens: accessTokens,
            tagReader: tagReader,
            fixturePhotosDirectory: launchOptions.fixturePhotosDirectory,
        )
        marketplaces = MarketplacesModel(service: APIConnectionsService(client: apiClient.client))
        devSignIn = configuration.environment == .dev
            ? DevSignInModel(client: DevSignInClient(baseURL: configuration.apiBaseURL), tokens: accessTokens)
            : nil
    }

    /// The background URLSession that photo uploads use; the app scene handles its events.
    public static let backgroundUploadSessionIdentifier = AddItemEnvironment.backgroundSessionIdentifier

    /// Starts work that runs whether or not a screen is visible: the photo upload queue.
    public func startBackgroundWork() {
        addItem.start()
    }

    /// Call when the system wakes the app for the upload session's events.
    public func handleBackgroundUploadEvents() async {
        await addItem.handleBackgroundSessionEvents()
    }

    /// Reads the build configuration from the bundle's Info.plist; throws when it is missing or
    /// invalid so a misconfigured build fails at launch instead of misbehaving later.
    public init(
        bundle: Bundle,
        dataDirectory: URL = AddItemEnvironment.defaultDataDirectory(),
        accessGrantStorage: (any AccessGrantStorage)? = nil,
        launchOptions: DebugLaunchOptions = .none,
    ) throws(ConfigurationError) {
        let info = bundle.infoDictionary ?? [:]
        try self.init(
            configuration: AppConfiguration(infoDictionary: info),
            version: AppVersion(infoDictionary: info),
            dataDirectory: dataDirectory,
            accessGrantStorage: accessGrantStorage,
            launchOptions: launchOptions,
        )
    }
}

/// Switches UI tests set through the launch environment. Only debug builds read them; release
/// builds always get ``none``.
public struct DebugLaunchOptions: Equatable, Sendable {
    /// `LISTORA_RESET_LOCAL_DATA=1`: start with no drafts and signed out.
    public var resetLocalData = false
    /// `LISTORA_FIXTURE_PHOTOS=<folder>`: "Import photos" adds that folder's JPEGs.
    public var fixturePhotosDirectory: URL?
    /// `LISTORA_DEV_ACCESS_TOKEN=<token>`: sign in with this bearer token (Dev only).
    public var accessToken: String?
    /// `LISTORA_DEV_API_BASE_URL=<url>`: talk to this API instead of the xcconfig one, and hand it
    /// to the Share Extension (`DevOverrides`, Dev only).
    public var apiBaseURL: URL?

    public static let none = DebugLaunchOptions()

    public init(
        resetLocalData: Bool = false,
        fixturePhotosDirectory: URL? = nil,
        accessToken: String? = nil,
        apiBaseURL: URL? = nil,
    ) {
        self.resetLocalData = resetLocalData
        self.fixturePhotosDirectory = fixturePhotosDirectory
        self.accessToken = accessToken
        self.apiBaseURL = apiBaseURL
    }

    /// The options in this process's environment (debug builds), otherwise ``none``.
    public static func fromProcessEnvironment() -> DebugLaunchOptions {
        #if DEBUG
            let environment = ProcessInfo.processInfo.environment
            return DebugLaunchOptions(
                resetLocalData: environment["LISTORA_RESET_LOCAL_DATA"] == "1",
                fixturePhotosDirectory: environment["LISTORA_FIXTURE_PHOTOS"].map { URL(
                    filePath: $0,
                    directoryHint: .isDirectory,
                ) },
                accessToken: environment["LISTORA_DEV_ACCESS_TOKEN"].flatMap { $0.isEmpty ? nil : $0 },
                apiBaseURL: environment["LISTORA_DEV_API_BASE_URL"].flatMap(URL.init(string:)),
            )
        #else
            return .none
        #endif
    }
}
