import Foundation

/// Build-time configuration, read once at launch from the app's Info.plist. The values come from
/// the xcconfig file of the active build configuration (`apps/ios/Config/*.xcconfig`), so the
/// same binary layout serves Dev, Staging, and Prod.
public struct AppConfiguration: Equatable, Sendable {
    /// Info.plist keys. Each one is set from an xcconfig variable of the same purpose.
    public enum InfoKey {
        public static let environment = "ListoraEnvironment"
        public static let apiBaseURL = "ListoraAPIBaseURL"
        public static let appGroup = "ListoraAppGroup"
        public static let sessionKeychainGroup = "ListoraSessionKeychainGroup"
        public static let cognitoRegion = "ListoraCognitoRegion"
        public static let cognitoClientID = "ListoraCognitoClientID"
        public static let supportEmail = "ListoraSupportEmail"
        public static let mediaBaseURL = "ListoraMediaBaseURL"
        public static let phoneKeychainGroup = "ListoraPhoneKeychainGroup"
    }

    public let environment: AppEnvironment
    public let apiBaseURL: URL
    /// The App Group the app shares with its Share Extension (the session keychain item).
    public let appGroupIdentifier: String
    /// The keychain access group of the signed-in session, which the app and its Share Extension
    /// both read. The App Group in every committed configuration; a team-prefixed Keychain
    /// Sharing group in personal device builds, whose free team has no App Groups
    /// (`make ios-install-device`, apps/ios/README.md).
    public let sessionKeychainGroup: String
    /// The Cognito user pool client the app signs in with outside Dev, or nil when the build has
    /// none (`COGNITO_CLIENT_ID` in the xcconfig is empty).
    public let cognito: CognitoConfiguration?
    /// Where Settings > Help and contact sends the seller's email, or nil when the build names no
    /// address (`SUPPORT_EMAIL` in the xcconfig is empty); Help then says so.
    public let supportEmail: String?
    /// Where the API's listing photos are served from when not from the API itself (the
    /// CloudFront distribution of the S3 storage driver), or nil when the API serves them (the
    /// local driver, Dev). The phone fetches a listing's photos only from these two
    /// (docs/features/phone-execution.md).
    public let mediaBaseURL: URL?
    /// The keychain access group of what only the app keeps (the phone's marketplace sessions):
    /// the app's own group, set in personal device builds, whose default group is the one shared
    /// with the Share Extension. Nil elsewhere, where the app's default group is its own.
    public let phoneKeychainGroup: String?

    public init(
        environment: AppEnvironment,
        apiBaseURL: URL,
        appGroupIdentifier: String,
        sessionKeychainGroup: String? = nil,
        cognito: CognitoConfiguration? = nil,
        supportEmail: String? = nil,
        mediaBaseURL: URL? = nil,
        phoneKeychainGroup: String? = nil,
    ) throws(ConfigurationError) {
        try Self.validate(apiBaseURL, key: InfoKey.apiBaseURL, for: environment)
        if let mediaBaseURL {
            try Self.validate(mediaBaseURL, key: InfoKey.mediaBaseURL, for: environment)
        }
        if let supportEmail, supportEmail.wholeMatch(of: /[^@\s]+@[^@\s]+\.[^@\s]+/) == nil {
            throw .invalid(key: InfoKey.supportEmail, reason: "must be an email address")
        }
        guard appGroupIdentifier.hasPrefix("group."), appGroupIdentifier.count > "group.".count else {
            throw .invalid(key: InfoKey.appGroup, reason: "must be an App Group identifier starting with group.")
        }
        self.environment = environment
        self.apiBaseURL = apiBaseURL
        self.appGroupIdentifier = appGroupIdentifier
        self.sessionKeychainGroup = sessionKeychainGroup ?? appGroupIdentifier
        self.cognito = cognito
        self.supportEmail = supportEmail
        self.mediaBaseURL = mediaBaseURL
        self.phoneKeychainGroup = phoneKeychainGroup
    }

    /// Parses and validates the configuration. Errors name the bad key but never echo its value.
    public init(infoDictionary: [String: Any]) throws(ConfigurationError) {
        let rawEnvironment = try Self.string(for: InfoKey.environment, in: infoDictionary)
        guard let environment = AppEnvironment(rawValue: rawEnvironment) else {
            throw .invalid(key: InfoKey.environment, reason: "must be one of dev, staging, prod")
        }
        let rawURL = try Self.string(for: InfoKey.apiBaseURL, in: infoDictionary)
        guard let url = URL(string: rawURL) else {
            throw .invalid(key: InfoKey.apiBaseURL, reason: Self.notAnHTTPURL)
        }
        let appGroup = try Self.string(for: InfoKey.appGroup, in: infoDictionary)
        let sessionKeychainGroup = try Self.string(for: InfoKey.sessionKeychainGroup, in: infoDictionary)
        var mediaBaseURL: URL?
        if let media = try Self.optionalString(for: InfoKey.mediaBaseURL, in: infoDictionary) {
            guard let parsed = URL(string: media) else {
                throw .invalid(key: InfoKey.mediaBaseURL, reason: Self.notAnHTTPURL)
            }
            mediaBaseURL = parsed
        }
        try self.init(
            environment: environment,
            apiBaseURL: url,
            appGroupIdentifier: appGroup,
            sessionKeychainGroup: sessionKeychainGroup,
            cognito: Self.cognito(in: infoDictionary),
            supportEmail: Self.optionalString(for: InfoKey.supportEmail, in: infoDictionary),
            mediaBaseURL: mediaBaseURL,
            phoneKeychainGroup: Self.optionalString(for: InfoKey.phoneKeychainGroup, in: infoDictionary),
        )
    }

    public init(bundle: Bundle) throws(ConfigurationError) {
        try self.init(infoDictionary: bundle.infoDictionary ?? [:])
    }

    private static let notAnHTTPURL = "must be an absolute http(s) URL with a host"

    /// The app client id turns sign-in on, and then needs its region. Without a client id the
    /// build has no sign-in, whatever the region says (Prod keeps its region while the client id
    /// waits for the first deploy).
    private static func cognito(in info: [String: Any]) throws(ConfigurationError) -> CognitoConfiguration? {
        guard let clientID = try optionalString(for: InfoKey.cognitoClientID, in: info) else { return nil }
        guard let region = try optionalString(for: InfoKey.cognitoRegion, in: info) else {
            throw .missing(key: InfoKey.cognitoRegion)
        }
        return try CognitoConfiguration(region: region, clientID: clientID)
    }

    /// A value that may be left empty: nil when missing, empty, or an unexpanded variable.
    private static func optionalString(for key: String, in info: [String: Any]) throws(ConfigurationError) -> String? {
        do throws(ConfigurationError) {
            return try string(for: key, in: info)
        } catch {
            guard case .missing = error else { throw error }
            return nil
        }
    }

    private static func string(for key: String, in info: [String: Any]) throws(ConfigurationError) -> String {
        guard let rawValue = info[key] else { throw .missing(key: key) }
        guard let value = rawValue as? String else { throw .invalid(key: key, reason: "must be a string") }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        // An unexpanded "$(VAR)" means the xcconfig variable was never defined.
        guard !trimmed.isEmpty, !trimmed.contains("$(") else { throw .missing(key: key) }
        return trimmed
    }

    private static func validate(
        _ url: URL,
        key: String,
        for environment: AppEnvironment,
    ) throws(ConfigurationError) {
        guard let scheme = url.scheme?.lowercased(), let host = url.host(), !host.isEmpty else {
            throw .invalid(key: key, reason: notAnHTTPURL)
        }
        switch scheme {
        case "https":
            break
        case "http" where environment.allowsInsecureHTTP:
            break
        case "http":
            throw .invalid(key: key, reason: "must use https outside Dev")
        default:
            throw .invalid(key: key, reason: notAnHTTPURL)
        }
        guard url.user() == nil, url.password() == nil else {
            throw .invalid(key: key, reason: "must not contain a user or password")
        }
        guard url.query() == nil, url.fragment() == nil else {
            throw .invalid(key: key, reason: "must not have a query or fragment")
        }
    }
}

/// The Cognito user pool app client the app signs in with (docs/features/auth.md): its region and
/// client id, neither of them a secret. The deploy prints both (infra/README.md).
public struct CognitoConfiguration: Equatable, Sendable {
    public let region: String
    public let clientID: String

    public init(region: String, clientID: String) throws(ConfigurationError) {
        guard region.wholeMatch(of: /[a-z]{2}(-[a-z]+)+-\d/) != nil else {
            throw .invalid(
                key: AppConfiguration.InfoKey.cognitoRegion,
                reason: "must be an AWS region such as us-east-1",
            )
        }
        guard clientID.wholeMatch(of: /[\w+]{1,128}/) != nil else {
            throw .invalid(key: AppConfiguration.InfoKey.cognitoClientID, reason: "must be a Cognito app client id")
        }
        self.region = region
        self.clientID = clientID
    }
}

public enum ConfigurationError: Error, Equatable, CustomStringConvertible {
    case missing(key: String)
    case invalid(key: String, reason: String)

    public var description: String {
        switch self {
        case let .missing(key):
            "Configuration key \(key) is missing. Set it in apps/ios/Config/*.xcconfig."
        case let .invalid(key, reason):
            "Configuration key \(key) \(reason)."
        }
    }
}
