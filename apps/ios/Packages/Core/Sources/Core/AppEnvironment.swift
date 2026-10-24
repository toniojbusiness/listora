/// The deployment environment a build talks to. Each Xcode build configuration (Dev, Staging,
/// Prod) sets `LISTORA_ENVIRONMENT` in its xcconfig file to one of these raw values.
public enum AppEnvironment: String, CaseIterable, Sendable {
    case dev
    case staging
    case prod

    public var displayName: String {
        switch self {
        case .dev: "Dev"
        case .staging: "Staging"
        case .prod: "Production"
        }
    }

    /// Only Dev may use plain HTTP, so it can reach the API on the developer's Mac.
    public var allowsInsecureHTTP: Bool {
        switch self {
        case .dev: true
        case .staging, .prod: false
        }
    }
}
