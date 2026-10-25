import APIClient
import Foundation
import Observation

/// The Today screen: what needs the seller, most urgent first, and the money summary. Every load
/// asks the server, which computes it fresh, so a card whose work is done is gone the next time
/// the screen appears.
@MainActor
@Observable
final class TodayModel {
    enum Phase: Equatable {
        case loading
        case loaded
        /// No session: nothing is asked of the server until the seller signs in.
        case signedOut
        /// The summary could not be loaded; `message` is safe to show.
        case failed(message: String)
    }

    private(set) var phase: Phase = .loading
    private(set) var cards: [TodayCardContent] = []
    private(set) var money: MoneySummaryContent?
    /// When the summary shown was computed.
    private(set) var generatedAt: Date?

    private let service: any TodayService
    private let isSignedIn: @MainActor () -> Bool
    private let now: @MainActor () -> Date
    private let timeZone: @MainActor () -> TimeZone
    private var timeZoneChecked = false

    init(
        service: any TodayService,
        isSignedIn: @escaping @MainActor () -> Bool = { true },
        now: @escaping @MainActor () -> Date = { Date() },
        timeZone: @escaping @MainActor () -> TimeZone = { .current },
    ) {
        self.service = service
        self.isSignedIn = isSignedIn
        self.now = now
        self.timeZone = timeZone
    }

    /// True once loaded with nothing to do.
    var isCaughtUp: Bool {
        phase == .loaded && cards.isEmpty
    }

    /// Loads the summary. Keeps the cards on screen while it loads, and keeps them when a later
    /// load fails, so a dropped connection never blanks the screen.
    func load() async {
        guard isSignedIn() else {
            cards = []
            money = nil
            phase = .signedOut
            return
        }
        if generatedAt == nil {
            phase = .loading
        }
        do {
            let today = try await service.today()
            let now = now()
            cards = today.cards.map { TodayCardContent($0, now: now) }
            money = MoneySummaryContent(today.money)
            generatedAt = today.generatedAt
            phase = .loaded
        } catch {
            if error.isUnauthenticated {
                cards = []
                money = nil
                generatedAt = nil
                phase = .signedOut
            } else if generatedAt == nil {
                phase = .failed(message: error.message)
            }
            return
        }
        await reportTimeZone()
    }

    /// The morning summary is sent at the seller's time in the server's copy of their time zone:
    /// once per launch, a zone that differs from this device's (never set, or the seller moved)
    /// is replaced, keeping their choice of on or off and the time. Best effort: the next launch
    /// tries again.
    private func reportTimeZone() async {
        guard !timeZoneChecked else { return }
        timeZoneChecked = true
        let zone = timeZone().identifier
        guard let settings = try? await service.summarySettings(), settings.timeZone != zone else { return }
        _ = try? await service.saveSummarySettings(enabled: settings.enabled, time: settings.time, timeZone: zone)
    }
}
