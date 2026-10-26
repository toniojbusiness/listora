import AddItemFeature
import APIClient
import Core
import Foundation
import InventoryFeature
import MarketplaceLinkingFeature
import MarketplacesFeature
import PhoneExecutionFeature
import PhotoSignalsFeature
import ReviewFeature
import SalesFeature
import SettingsFeature
import SignInFeature
import SwiftUI
import TagReadingFeature
import TasksFeature
import TodayFeature
import VoiceInputFeature

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
    /// The Sales tab, "Mark as sold", and each sale's screen.
    public let sales: SalesEnvironment
    /// The task inbox, its badge, and the urgent tasks' reminders.
    public let tasks: TasksEnvironment
    /// The Today screen, whose cards open the item and marketplace screens.
    public let today: TodayEnvironment
    /// The session and the sign-in screens, the root while nobody is signed in: the local API's dev
    /// driver in Dev builds, otherwise the environment's Cognito user pool, with an emailed code.
    public let signIn: SignInModel
    /// Settings > Delete account.
    public let accountDeletion: AccountDeletionModel
    /// The Marketplaces screen (in Settings): connection status and connecting eBay.
    public let marketplaces: MarketplacesModel
    /// Link accounts: sign in on Poshmark, Mercari, Depop, and eBay for Listora to automate them.
    public let linkAccounts: LinkAccountsModel
    /// The marketplace work Listora hands this phone, run in the seller's own session here
    /// (docs/features/phone-execution.md).
    public let phone: PhoneExecutionEnvironment
    /// The first-run guide, shown once after the first sign-in.
    public let gettingStarted: GettingStartedModel

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
            ?? KeychainAccessGrantStorage.session(accessGroup: configuration.sessionKeychainGroup)
        let interactionStorage = UserDefaultsInteractionStorage(defaults: defaults)
        if launchOptions.resetLocalData {
            Self.resetLocalData([dataDirectory, listingCopyDirectory], interactionStorage, defaults, accessGrantStorage)
        }
        let (accessTokens, signIn) = Self.session(configuration, accessGrantStorage, launchOptions)
        self.accessTokens = accessTokens
        self.signIn = signIn
        // A screen that finds itself signed out (its server answered 401) opens the sign-in.
        let showSignIn: @MainActor () -> Void = { signIn.showSignIn() }
        apiClient = APIClient(baseURL: configuration.apiBaseURL, accessTokens: accessTokens)
        tagReader = VisionTagReader()
        interactionMeter = InteractionMeter(storage: interactionStorage)
        let listingCopy = ListingCopyStore(directory: listingCopyDirectory)
        let review = ReviewEnvironment(
            apiClient: apiClient, meter: interactionMeter, listingCopy: listingCopy,
            transcriber: Self.transcriber(for: launchOptions), defaults: defaults,
        )
        phone = PhoneExecutionEnvironment(apiClient: apiClient, accessTokens: accessTokens, version: version)
        sales = SalesEnvironment(
            apiClient: apiClient, accessTokens: accessTokens, onSignIn: showSignIn, phoneWork: phone.runner,
        )
        tasks = TasksEnvironment(apiClient: apiClient, accessTokens: accessTokens, onSignIn: showSignIn)
        inventory = InventoryEnvironment(
            apiClient: apiClient, accessTokens: accessTokens, listingCopy: listingCopy,
            saleScreens: Self.saleScreens(sales),
            taskDestination: tasks.taskScreen(itemID:operationID:onFinished:),
            onSignIn: showSignIn, phoneWork: phone.runner,
        )
        inventory.reviewScreen = { request, onFinished in AnyView(review.flow(for: request, onFinished: onFinished)) }
        self.review = review
        addItem = AddItemEnvironment(
            dataDirectory: dataDirectory, apiClient: apiClient, accessTokens: accessTokens, tagReader: tagReader,
            signalReader: VisionPhotoSignalReader(), meter: interactionMeter,
            reviewDestination: { request, onFinished in AnyView(review.flow(for: request, onFinished: onFinished)) },
            batchReviewDestination: { request, onEvent in AnyView(review.batchFlow(for: request, onEvent: onEvent)) },
            fixturePhotosDirectory: launchOptions.fixturePhotosDirectory,
            fakeCameraDirectory: launchOptions.fakeCameraDirectory,
        )
        marketplaces = Self.makeMarketplaces(apiClient, accessTokens, phone)
        linkAccounts = Self.makeLinkAccounts(apiClient, phone, configuration)
        today = Self.makeToday(apiClient, accessTokens, (inventory, sales), marketplaces, showSignIn)
        accountDeletion = Self.makeAccountDeletion(apiClient, accessTokens, signIn, phone.sessions)
        gettingStarted = GettingStartedModel(defaults: defaults, showsNow: launchOptions.showsGettingStarted)
    }

    /// Deleting the account (Settings). It signs out, but its result (the marketplaces to revoke by
    /// hand) stays on screen until Settings closes; then the sign-in shows. It also removes the
    /// marketplace sessions this phone kept for the account.
    private static func makeAccountDeletion(
        _ apiClient: APIClient,
        _ accessTokens: AccessTokenStore,
        _ signIn: SignInModel,
        _ sessions: any MarketplaceSessionStore,
    ) -> AccountDeletionModel {
        AccountDeletionModel(
            service: APIAccountDeletionService(client: apiClient.client),
            isSignedIn: { accessTokens.grant != nil },
            signOut: {
                signIn.signOutKeepingScreen()
                sessions.removeAll()
            },
        )
    }

    /// Marketplaces: each connection's health, and where its automated steps run.
    private static func makeMarketplaces(
        _ apiClient: APIClient,
        _ accessTokens: AccessTokenStore,
        _ phone: PhoneExecutionEnvironment,
    ) -> MarketplacesModel {
        let model = MarketplacesModel(
            service: APIConnectionsService(client: apiClient.client),
            isSignedIn: { accessTokens.grant != nil },
        )
        model.phoneWork = phone.runner
        return model
    }

    /// Link accounts: the marketplaces linked by signing in, and the sale email forwarding. A
    /// sign-in's cookies stay on this phone too, and a sign-in link shared to the extension reaches it.
    private static func makeLinkAccounts(
        _ apiClient: APIClient,
        _ phone: PhoneExecutionEnvironment,
        _ configuration: AppConfiguration,
    ) -> LinkAccountsModel {
        LinkAccountsModel(
            service: APIMarketplaceSessionService(api: apiClient),
            saleEmails: SaleEmailsModel(service: APISaleEmailsService(api: apiClient)),
            sessions: phone.sessions,
            signInLinks: KeychainSignInLinkHandoff(accessGroup: configuration.sessionKeychainGroup),
            phoneWork: phone.runner,
        )
    }

    /// The Today screen, whose cards open the item, sale, and marketplace connection screens.
    private static func makeToday(
        _ apiClient: APIClient,
        _ accessTokens: AccessTokenStore,
        _ screens: (inventory: InventoryEnvironment, sales: SalesEnvironment),
        _ marketplaces: MarketplacesModel,
        _ showSignIn: @escaping @MainActor () -> Void,
    ) -> TodayEnvironment {
        TodayEnvironment(
            apiClient: apiClient,
            accessTokens: accessTokens,
            itemDestination: { itemID in AnyView(screens.inventory.itemDetail(itemID: itemID)) },
            saleDestination: { saleID in AnyView(screens.sales.saleScreen(saleID: saleID)) },
            marketplacesDestination: { AnyView(MarketplacesView(model: marketplaces)) },
            onSignIn: showSignIn,
        )
    }

    /// The session, and the sign-in that starts and follows it. In Dev, UI tests can start signed
    /// in (`LISTORA_DEV_ACCESS_TOKEN`).
    private static func session(
        _ configuration: AppConfiguration,
        _ storage: any AccessGrantStorage,
        _ launchOptions: DebugLaunchOptions,
    ) -> (AccessTokenStore, SignInModel) {
        let cognito = cognitoClient(configuration)
        let accessTokens = AccessTokenStore(storage: storage, refresher: cognito)
        if let grant = launchOptions.accessGrant, configuration.environment == .dev {
            accessTokens.signIn(grant)
        }
        return (accessTokens, SignInModel(method: signInMethod(configuration, cognito), tokens: accessTokens))
    }

    /// The Cognito client of a build with a user pool app client. The Share Extension builds the
    /// same one (ShareViewController), so either can renew the session they share.
    private static func cognitoClient(_ configuration: AppConfiguration) -> CognitoSignInClient? {
        configuration.cognito.map { CognitoSignInClient(region: $0.region, clientID: $0.clientID) }
    }

    /// Dev signs in with the local API's dev driver; Staging and Prod with their user pool, when
    /// the build has its app client, and otherwise not at all.
    private static func signInMethod(
        _ configuration: AppConfiguration,
        _ cognito: CognitoSignInClient?,
    ) -> (any SignInMethod)? {
        if configuration.environment == .dev {
            return DevSignIn(client: DevSignInClient(baseURL: configuration.apiBaseURL))
        }
        return cognito.map(EmailCodeSignIn.init(client:))
    }

    /// The sales screens the item screen opens, from the sales feature.
    private static func saleScreens(_ sales: SalesEnvironment) -> SaleScreens {
        SaleScreens(
            markSold: { request, onRecorded in AnyView(sales.markSold(request, onRecorded: onRecorded)) },
            sale: { saleID in AnyView(sales.saleScreen(saleID: saleID)) },
        )
    }

    /// `LISTORA_RESET_LOCAL_DATA`: no drafts, no saved copy or interaction times, no marketplace
    /// sessions on the phone, signed out.
    private static func resetLocalData(
        _ directories: [URL],
        _ interactionStorage: UserDefaultsInteractionStorage,
        _ defaults: UserDefaults,
        _ accessGrantStorage: any AccessGrantStorage,
    ) {
        for directory in directories {
            try? FileManager.default.removeItem(at: directory)
        }
        interactionStorage.reset()
        KeychainMarketplaceSessionStore().removeAll()
        ReviewEnvironment.resetLocalData(defaults: defaults)
        AddItemEnvironment.resetLocalData(defaults: defaults)
        GettingStartedModel.resetLocalData(defaults: defaults)
        InventoryEnvironment.resetLocalData(defaults: defaults)
        accessGrantStorage.save(nil)
    }

    /// The microphone, or in UI tests the transcript they script (`LISTORA_VOICE_TRANSCRIPT`).
    private static func transcriber(for launchOptions: DebugLaunchOptions) -> any VoiceTranscriber {
        if let transcript = launchOptions.voiceTranscript {
            return ScriptedVoiceTranscriber(transcript: transcript, authorization: launchOptions.voicePermission)
        }
        return AppleSpeechTranscriber()
    }

    /// The background URLSession that photo uploads use; the app scene handles its events.
    public static let backgroundUploadSessionIdentifier = AddItemEnvironment.backgroundSessionIdentifier

    /// Starts work that runs whether or not a screen is visible: the photo upload queue,
    /// opening the Tasks tab from a tapped task reminder, and the marketplace work this phone
    /// runs: on a push, on background app refresh, and overnight (docs/features/phone-execution.md).
    public func startBackgroundWork() {
        addItem.start()
        let runner = phone.runner
        tasks.startNotifications { await runner.runUntilDone(.push) }
        ListoraAppDelegate.phone = phone
        Self.registerBackgroundWork(runner)
    }

    private static var backgroundWorkRegistered = false

    /// The background tasks' handlers, once (iOS refuses a second registration).
    private static func registerBackgroundWork(_ runner: PhoneRunner) {
        guard !backgroundWorkRegistered, Bundle.main.bundleURL.pathExtension == "app" else { return }
        backgroundWorkRegistered = true
        PhoneBackgroundWork.register { [weak runner] in runner }
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
    /// `LISTORA_RESET_LOCAL_DATA=1`: start with no drafts and signed out, on the welcome screen.
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
    /// `LISTORA_VOICE_TRANSCRIPT=<text>`: the talk button "hears" this instead of the microphone,
    /// which the simulator cannot feed.
    public var voiceTranscript: String?
    /// `LISTORA_VOICE_PERMISSION=denied|restricted`: asking for voice permission ends this way
    /// (with ``voiceTranscript``; granted otherwise).
    public var voicePermission: SpeechAuthorization = .authorized
    /// `LISTORA_SHOW_GETTING_STARTED=1`: show the first-run guide at launch, as after a first
    /// sign-in (the screenshot tour).
    public var showsGettingStarted = false

    public static let none = DebugLaunchOptions()

    public init(
        resetLocalData: Bool = false,
        fixturePhotosDirectory: URL? = nil,
        fakeCameraDirectory: URL? = nil,
        apiBaseURL: URL? = nil,
        accessGrant: AccessGrant? = nil,
        voiceTranscript: String? = nil,
        voicePermission: SpeechAuthorization = .authorized,
        showsGettingStarted: Bool = false,
    ) {
        self.resetLocalData = resetLocalData
        self.fixturePhotosDirectory = fixturePhotosDirectory
        self.fakeCameraDirectory = fakeCameraDirectory
        self.apiBaseURL = apiBaseURL
        self.accessGrant = accessGrant
        self.voiceTranscript = voiceTranscript
        self.voicePermission = voicePermission
        self.showsGettingStarted = showsGettingStarted
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
            voiceTranscript: environment["LISTORA_VOICE_TRANSCRIPT"],
            voicePermission: voicePermission(environment["LISTORA_VOICE_PERMISSION"]),
            showsGettingStarted: environment["LISTORA_SHOW_GETTING_STARTED"] == "1",
        )
    }

    private static func voicePermission(_ value: String?) -> SpeechAuthorization {
        switch value {
        case "denied": .microphoneDenied
        case "restricted": .restricted
        default: .authorized
        }
    }
}
