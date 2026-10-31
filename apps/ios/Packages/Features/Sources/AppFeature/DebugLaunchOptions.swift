import APIClient
import Core
import Foundation

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
    /// `LISTORA_SCANNED_CODES=<code>|<code>...`: Pack check's scanner "reads" these, one per tap
    /// of Scan, instead of the camera the simulator lacks.
    public var scannedCodes: [String]?
    /// `LISTORA_SCRIPTED_PRINTING=1`: Pack check's label printing gets a test label instead of the
    /// marketplace's, and every print "prints" at once, with no print sheet.
    public var scriptedPrinting = false
    /// `LISTORA_SCAN_NO_SIGNAL=1`: the thrift scan finds no signal, as at the bins of a store,
    /// so its reads wait in the queue until a launch without it.
    public var scanHasNoSignal = false

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
        scannedCodes: [String]? = nil,
        scriptedPrinting: Bool = false,
        scanHasNoSignal: Bool = false,
    ) {
        self.resetLocalData = resetLocalData
        self.fixturePhotosDirectory = fixturePhotosDirectory
        self.fakeCameraDirectory = fakeCameraDirectory
        self.apiBaseURL = apiBaseURL
        self.accessGrant = accessGrant
        self.voiceTranscript = voiceTranscript
        self.voicePermission = voicePermission
        self.showsGettingStarted = showsGettingStarted
        self.scannedCodes = scannedCodes
        self.scriptedPrinting = scriptedPrinting
        self.scanHasNoSignal = scanHasNoSignal
    }

    /// The options in this process's environment (debug builds), otherwise ``none``.
    public static func fromProcessEnvironment() -> DebugLaunchOptions {
        #if DEBUG
            from(environment: ProcessInfo.processInfo.environment)
        #else
            .none
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
            scannedCodes: environment["LISTORA_SCANNED_CODES"].map { $0.split(separator: "|").map(String.init) },
            scriptedPrinting: environment["LISTORA_SCRIPTED_PRINTING"] == "1",
            scanHasNoSignal: environment["LISTORA_SCAN_NO_SIGNAL"] == "1",
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
