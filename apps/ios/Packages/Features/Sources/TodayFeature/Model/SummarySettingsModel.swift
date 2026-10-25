import APIClient
import Foundation
import Observation

/// The morning summary setting: on or off, and the time, in this device's time zone. Saved to the
/// server, which sends the notification.
@MainActor
@Observable
final class SummarySettingsModel {
    enum Phase: Equatable {
        case loading
        case loaded
        case failed(message: String)
    }

    private(set) var phase: Phase = .loading
    var isEnabled = true
    /// The time of day, as hour and minute.
    var time = DateComponents(hour: 8, minute: 0)
    private(set) var isSaving = false
    /// The last save's failure, safe to show.
    private(set) var saveError: String?

    private let service: any TodayService
    private let timeZone: @MainActor () -> TimeZone

    init(service: any TodayService, timeZone: @escaping @MainActor () -> TimeZone = { .current }) {
        self.service = service
        self.timeZone = timeZone
    }

    func load() async {
        phase = .loading
        do {
            let settings = try await service.summarySettings()
            isEnabled = settings.enabled
            time = Self.components(settings.time) ?? time
            phase = .loaded
        } catch {
            phase = .failed(message: error.message)
        }
    }

    /// Saves the setting; true when the server has it.
    func save() async -> Bool {
        isSaving = true
        saveError = nil
        defer { isSaving = false }
        do {
            let saved = try await service.saveSummarySettings(
                enabled: isEnabled,
                time: Self.text(time),
                timeZone: timeZone().identifier,
            )
            isEnabled = saved.enabled
            time = Self.components(saved.time) ?? time
            return true
        } catch {
            saveError = error.message
            return false
        }
    }

    /// `08:05` as hour 8, minute 5.
    static func components(_ text: String) -> DateComponents? {
        let parts = text.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2, (0 ..< 24).contains(parts[0]), (0 ..< 60).contains(parts[1]) else { return nil }
        return DateComponents(hour: parts[0], minute: parts[1])
    }

    /// Hour 8, minute 5 as `08:05`.
    static func text(_ components: DateComponents) -> String {
        String(format: "%02d:%02d", components.hour ?? 0, components.minute ?? 0)
    }
}
