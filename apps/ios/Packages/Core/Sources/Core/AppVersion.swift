/// The app's marketing version and build number, as shown to users and in support requests.
public struct AppVersion: Equatable, Sendable, CustomStringConvertible {
    public let marketing: String
    public let build: String

    public init(marketing: String, build: String) {
        self.marketing = marketing
        self.build = build
    }

    /// Reads `CFBundleShortVersionString` and `CFBundleVersion`; a missing value reads as "?".
    public init(infoDictionary: [String: Any]) {
        marketing = Self.nonEmpty(infoDictionary["CFBundleShortVersionString"]) ?? "?"
        build = Self.nonEmpty(infoDictionary["CFBundleVersion"]) ?? "?"
    }

    public var description: String {
        "\(marketing) (\(build))"
    }

    private static func nonEmpty(_ value: Any?) -> String? {
        guard let string = value as? String, !string.isEmpty else { return nil }
        return string
    }
}
