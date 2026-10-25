import AddItemFeature
import APIClient
import Core
import Foundation
import InventoryFeature
import MarketplacesFeature
import ReviewFeature
import SettingsFeature
import SwiftUI
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
    /// Measures each new item's active interaction time and taps, from the first photo to the
    /// saved item. The root view feeds it the app's taps and foreground state.
    public let interactionMeter: InteractionMeter
    /// Analysis progress, review, cost, price, and saving a new item.
    public let review: ReviewEnvironment
    /// Drafts and the photo upload queue.
    public let addItem: AddItemEnvironment
    /// The inventory, item, and listing screens.
    public let inventory: InventoryEnvironment
    /// Dev builds only: sign in against the local API's dev auth driver.
    public let devSignIn: DevSignInModel?
    /// The Marketplaces screen (in Settings): connection status and connecting eBay.
    public let marketplaces: MarketplacesModel

    public init(
        configuration: AppConfiguration,
        version: AppVersion,
        dataDirectory: URL = AddItemEnvironment.defaultDataDirectory(),
        listingCopyDirectory: URL = ListingCopyStore.defaultDirectory(),
        defaults: UserDefaults = .standard,
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
        let interactionStorage = UserDefaultsInteractionStorage(defaults: defaults)
        if launchOptions.resetLocalData {
            try? FileManager.default.removeItem(at: dataDirectory)
            try? FileManager.default.removeItem(at: listingCopyDirectory)
            interactionStorage.reset()
            ReviewEnvironment.resetLocalData(defaults: defaults)
            accessGrantStorage.save(nil)
        }
        let accessTokens = AccessTokenStore(storage: accessGrantStorage)
        if let grant = launchOptions.accessGrant, configuration.environment == .dev {
            accessTokens.signIn(grant)
        }
        self.accessTokens = accessTokens
        apiClient = APIClient(baseURL: configuration.apiBaseURL, accessTokens: accessTokens)
        let tagReader = VisionTagReader()
        self.tagReader = tagReader
        let meter = InteractionMeter(storage: interactionStorage)
        interactionMeter = meter
        let listingCopy = ListingCopyStore(directory: listingCopyDirectory)
        let review = ReviewEnvironment(
            apiClient: apiClient,
            meter: meter,
            listingCopy: listingCopy,
            defaults: defaults,
        )
        inventory = InventoryEnvironment(apiClient: apiClient, accessTokens: accessTokens, listingCopy: listingCopy)
        self.review = review
        addItem = AddItemEnvironment(
            dataDirectory: dataDirectory,
            apiClient: apiClient,
            accessTokens: accessTokens,
            tagReader: tagReader,
            meter: meter,
            reviewDestination: { request, onFinished in
                AnyView(review.flow(for: request, onFinished: onFinished))
            },
            fixturePhotosDirectory: launchOptions.fixturePhotosDirectory,
            fakeCameraDirectory: launchOptions.fakeCameraDirectory,
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
        listingCopyDirectory: URL = ListingCopyStore.defaultDirectory(),
        defaults: UserDefaults = .standard,
        accessGrantStorage: (any AccessGrantStorage)? = nil,
        launchOptions: DebugLaunchOptions = .none,
    ) throws(ConfigurationError) {
        let info = bundle.infoDictionary ?? [:]
        try self.init(
            configuration: AppConfiguration(infoDictionary: info),
            version: AppVersion(infoDictionary: info),
            dataDirectory: dataDirectory,
            listingCopyDirectory: listingCopyDirectory,
            defaults: defaults,
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
    /// `LISTORA_FAKE_CAMERA=<folder>`: the guided capture "takes" that folder's JPEGs, so the
    /// simulator shows the camera flow.
    public var fakeCameraDirectory: URL?
    /// `LISTORA_DEV_API_BASE_URL=<url>`: talk to this API instead of the xcconfig one (the UI
    /// tests' local stack or stub), and hand it to the Share Extension (`DevOverrides`, Dev only).
    public var apiBaseURL: URL?
    /// `LISTORA_DEV_ACCESS_TOKEN=<token>` (with `LISTORA_DEV_ACCESS_EMAIL`): start signed in with
    /// this session, which the UI tests' local stack signed in through the dev auth driver (Dev only).
    public var accessGrant: AccessGrant?

    public static let none = DebugLaunchOptions()

    public init(
        resetLocalData: Bool = false,
        fixturePhotosDirectory: URL? = nil,
        fakeCameraDirectory: URL? = nil,
        apiBaseURL: URL? = nil,
        accessGrant: AccessGrant? = nil,
    ) {
        self.resetLocalData = resetLocalData
        self.fixturePhotosDirectory = fixturePhotosDirectory
        self.fakeCameraDirectory = fakeCameraDirectory
        self.apiBaseURL = apiBaseURL
        self.accessGrant = accessGrant
    }

    /// The options in this process's environment (debug builds), otherwise ``none``.
    public static func fromProcessEnvironment() -> DebugLaunchOptions {
        #if DEBUG
            from(environment: ProcessInfo.processInfo.environment)
        #else
            return .none
        #endif
    }

    /// The options in a launch environment.
    public static func from(environment: [String: String], now: Date = Date()) -> DebugLaunchOptions {
        let token = environment["LISTORA_DEV_ACCESS_TOKEN"].flatMap { $0.isEmpty ? nil : $0 }
        return DebugLaunchOptions(
            resetLocalData: environment["LISTORA_RESET_LOCAL_DATA"] == "1",
            fixturePhotosDirectory: environment["LISTORA_FIXTURE_PHOTOS"].map {
                URL(filePath: $0, directoryHint: .isDirectory)
            },
            fakeCameraDirectory: environment["LISTORA_FAKE_CAMERA"].map {
                URL(filePath: $0, directoryHint: .isDirectory)
            },
            apiBaseURL: environment["LISTORA_DEV_API_BASE_URL"].flatMap(URL.init(string:)),
            // Dev sessions last a day; the server refuses the token once it ends.
            accessGrant: token.map {
                AccessGrant(
                    accessToken: $0,
                    expiresAt: now.addingTimeInterval(24 * 60 * 60),
                    email: environment["LISTORA_DEV_ACCESS_EMAIL"] ?? "ui-test@listora.test",
                )
            },
        )
    }
}
