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
    }

    public let environment: AppEnvironment
    public let apiBaseURL: URL
    /// The App Group the app shares with its Share Extension (the session keychain item).
    public let appGroupIdentifier: String

    public init(
        environment: AppEnvironment,
        apiBaseURL: URL,
        appGroupIdentifier: String,
    ) throws(ConfigurationError) {
        try Self.validate(apiBaseURL, key: InfoKey.apiBaseURL, for: environment)
        guard appGroupIdentifier.hasPrefix("group."), appGroupIdentifier.count > "group.".count else {
            throw .invalid(key: InfoKey.appGroup, reason: "must be an App Group identifier starting with group.")
        }
        self.environment = environment
        self.apiBaseURL = apiBaseURL
        self.appGroupIdentifier = appGroupIdentifier
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
        try self.init(environment: environment, apiBaseURL: url, appGroupIdentifier: appGroup)
    }

    public init(bundle: Bundle) throws(ConfigurationError) {
        try self.init(infoDictionary: bundle.infoDictionary ?? [:])
    }

    private static let notAnHTTPURL = "must be an absolute http(s) URL with a host"

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
