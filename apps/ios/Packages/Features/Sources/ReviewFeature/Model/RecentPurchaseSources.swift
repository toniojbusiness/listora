import Foundation

/// The places the seller bought items lately ("Goodwill", "Estate sale"), offered as one-tap
/// choices on the cost screen. Kept on this iPhone, newest first.
/// `UserDefaults` is documented as thread-safe but is not marked `Sendable`, hence `@unchecked`.
struct RecentPurchaseSources: @unchecked Sendable {
    static let defaultKey = "com.listora.recent-purchase-sources"
    static let limit = 6

    private let defaults: UserDefaults
    private let key: String

    init(defaults: UserDefaults = .standard, key: String = defaultKey) {
        self.defaults = defaults
        self.key = key
    }

    var sources: [String] {
        defaults.stringArray(forKey: key) ?? []
    }

    /// Moves `source` to the front (case-insensitively unique), keeping at most ``limit``.
    func remember(_ source: String) {
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let others = sources.filter { $0.caseInsensitiveCompare(trimmed) != .orderedSame }
        defaults.set(Array(([trimmed] + others).prefix(Self.limit)), forKey: key)
    }

    func reset() {
        defaults.removeObject(forKey: key)
    }
}
