import Foundation

/// The places the seller bought items lately ("Goodwill", "Estate sale"), offered as one-tap
/// choices on the cost screen and when a thrift scan run starts. Kept on this iPhone, newest
/// first.
/// `UserDefaults` is documented as thread-safe but is not marked `Sendable`, hence `@unchecked`.
public struct RecentPurchaseSources: @unchecked Sendable {
    public static let defaultKey = "com.listora.recent-purchase-sources"
    public static let limit = 6

    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = defaultKey) {
        self.defaults = defaults
        self.key = key
    }

    public var sources: [String] {
        defaults.stringArray(forKey: key) ?? []
    }

    /// Moves `source` to the front (case-insensitively unique), keeping at most ``limit``.
    public func remember(_ source: String) {
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let others = sources.filter { $0.caseInsensitiveCompare(trimmed) != .orderedSame }
        defaults.set(Array(([trimmed] + others).prefix(Self.limit)), forKey: key)
    }

    public func reset() {
        defaults.removeObject(forKey: key)
    }
}
