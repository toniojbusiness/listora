import APIClient
import Foundation
import ListoraAPI
import Observation

/// The listing refresh setting (docs/features/listing-refresh.md): how often Listora refreshes
/// live listings that haven't sold, the quiet hours, in this device's time zone, and whether
/// Depop listings are relisted to refresh them (off until the seller turns it on).
@MainActor
@Observable
final class ListingRefreshSettingsModel {
    enum Phase: Equatable {
        case loading
        case loaded
        case failed(message: String)
    }

    private(set) var phase: Phase = .loading
    var cadence: Components.Schemas.KnownRefreshCadence = .every72Hours
    /// Hours between refreshes with `custom`.
    var customHours = 48
    var hasQuietHours = false
    var quietStart = DateComponents(hour: 22, minute: 0)
    var quietEnd = DateComponents(hour: 7, minute: 0)
    /// Whether Depop listings are refreshed by relisting them, which resets their likes.
    var relistOnDepop = false
    /// Whether the seller is shown the Depop relist switch: only where Depop's refresh shows.
    let showsDepopRelist: Bool
    private(set) var isSaving = false
    /// The last save's failure, safe to show.
    private(set) var saveError: String?

    static let customHoursRange = 12 ... 720

    private let service: any ListingRefreshService
    private let timeZone: @MainActor () -> TimeZone

    init(
        service: any ListingRefreshService,
        showsDepopRelist: Bool = false,
        timeZone: @escaping @MainActor () -> TimeZone = { .current },
    ) {
        self.service = service
        self.showsDepopRelist = showsDepopRelist
        self.timeZone = timeZone
    }

    func load() async {
        phase = .loading
        do {
            try await apply(service.settings())
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
        let window = hasQuietHours
            ? Components.Schemas.QuietWindow(start: Self.text(quietStart), end: Self.text(quietEnd))
            : nil
        do {
            try await apply(service.saveSettings(.init(
                relistToRefresh: relistOnDepop,
                cadence: cadence,
                customHours: cadence == .custom ? Int32(customHours) : nil,
                quietWindow: window,
                timeZone: timeZone().identifier,
            )))
            return true
        } catch {
            saveError = error.message
            return false
        }
    }

    /// Whether the quiet hours are an empty window (the server refuses one).
    var quietHoursAreEmpty: Bool {
        hasQuietHours && Self.text(quietStart) == Self.text(quietEnd)
    }

    private func apply(_ settings: Components.Schemas.ListingRefreshSettings) {
        cadence = settings.cadence.value1 ?? .every72Hours
        relistOnDepop = settings.relistToRefresh
        if let hours = settings.customHours {
            customHours = Int(hours)
        }
        if let window = settings.quietWindow,
           let start = Self.components(window.start),
           let end = Self.components(window.end)
        {
            hasQuietHours = true
            quietStart = start
            quietEnd = end
        } else {
            hasQuietHours = false
        }
    }

    /// `22:05` as hour 22, minute 5.
    static func components(_ text: String) -> DateComponents? {
        let parts = text.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2, (0 ..< 24).contains(parts[0]), (0 ..< 60).contains(parts[1]) else { return nil }
        return DateComponents(hour: parts[0], minute: parts[1])
    }

    /// Hour 22, minute 5 as `22:05`.
    static func text(_ components: DateComponents) -> String {
        String(format: "%02d:%02d", components.hour ?? 0, components.minute ?? 0)
    }
}
