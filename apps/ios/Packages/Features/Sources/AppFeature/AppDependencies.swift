import APIClient
import Core
import Foundation

/// Everything the app's features need, built once at launch.
public struct AppDependencies: Sendable {
    public let configuration: AppConfiguration
    public let version: AppVersion
    public let apiClient: APIClient

    public init(configuration: AppConfiguration, version: AppVersion) {
        self.configuration = configuration
        self.version = version
        apiClient = APIClient(baseURL: configuration.apiBaseURL)
    }

    /// Reads the build configuration from the bundle's Info.plist; throws when it is missing or
    /// invalid so a misconfigured build fails at launch instead of misbehaving later.
    public init(bundle: Bundle) throws(ConfigurationError) {
        let info = bundle.infoDictionary ?? [:]
        try self.init(configuration: AppConfiguration(infoDictionary: info), version: AppVersion(infoDictionary: info))
    }
}
