import APIClient
import Foundation
import Observation

/// Whether Pack check is on (Settings > Pack check), saved on the server. The last answer is kept
/// on the phone so the Sales tab shows "Pack orders" at once, before the server answers.
@MainActor
@Observable
public final class PackCheckSettingsModel {
    enum Phase: Equatable {
        case loading
        case loaded
        case failed(message: String)
    }

    private(set) var phase: Phase = .loading
    /// On or off, as last saved (or as the phone last knew it).
    public private(set) var isEnabled: Bool
    private(set) var isSaving = false
    private(set) var saveError: String?

    private let service: any PackCheckService
    private let defaults: UserDefaults
    /// Runs the label reads Listora asked this phone for once Pack check turns on.
    private let onEnabled: @MainActor () -> Void
    static let defaultsKey = "packCheck.enabled"

    init(
        service: any PackCheckService,
        defaults: UserDefaults = .standard,
        onEnabled: @escaping @MainActor () -> Void = {},
    ) {
        self.service = service
        self.defaults = defaults
        self.onEnabled = onEnabled
        isEnabled = defaults.bool(forKey: Self.defaultsKey)
    }

    func load() async {
        if phase != .loaded {
            phase = .loading
        }
        do {
            try await apply(service.isEnabled())
            phase = .loaded
        } catch {
            phase = .failed(message: error.message)
        }
    }

    /// Turns Pack check on or off; on failure it stays as it was and says why.
    func setEnabled(_ enabled: Bool) async {
        guard enabled != isEnabled, !isSaving else { return }
        isSaving = true
        saveError = nil
        defer { isSaving = false }
        do {
            try await apply(service.setEnabled(enabled))
            if isEnabled {
                onEnabled()
            }
        } catch {
            saveError = error.message
        }
    }

    private func apply(_ enabled: Bool) {
        isEnabled = enabled
        defaults.set(enabled, forKey: Self.defaultsKey)
    }

    static func resetLocalData(defaults: UserDefaults) {
        defaults.removeObject(forKey: defaultsKey)
    }
}
