import DesignSystem
import Foundation
import ListoraAPI

/// Where a card's primary action goes.
public enum TodayDestination: Hashable, Sendable {
    /// The item screen.
    case item(id: String)
    /// The sale's screen.
    case sale(id: String)
    /// The marketplace connections screen.
    case marketplaces
    /// The drafts waiting for review (the Add Item tab).
    case drafts
}

/// What one Today card shows, from the server's card: its icon, how urgent it looks, its facts as
/// chips, and its one action. The words are the server's; dates read in the device's calendar.
struct TodayCardContent: Equatable, Identifiable {
    struct Badge: Equatable {
        let label: String
        let tone: StatusTone
    }

    struct Fact: Equatable, Hashable {
        let text: String
        let systemImage: String
        /// Set for a fact that needs attention (an overdue ship-by date).
        var tone: StatusTone?
    }

    struct Action: Equatable {
        let label: String
        let destination: TodayDestination
    }

    let id: String
    let title: String
    let detail: String?
    let systemImage: String
    let iconTone: StatusTone?
    let thumbnailURL: URL?
    /// "Urgent" or "Soon"; none for a card that can wait.
    let urgency: Badge?
    /// The server's honest status for the card's work (a delist's progress).
    let status: Badge?
    let facts: [Fact]
    /// None for a card this app cannot open.
    let action: Action?

    init(_ card: TodayCard, now: Date, calendar: Calendar = .current) {
        id = card.id
        title = card.title
        thumbnailURL = card.item?.thumbnailUrl.flatMap(URL.init(string:))
        urgency = switch card.urgency.value1 {
        case .urgent: Badge(label: "Urgent", tone: .actionNeeded)
        case .high: Badge(label: "Soon", tone: .neutral)
        case .normal, nil: nil
        }
        action = Self.action(card.action)
        let kind: KindContent = switch card.kind.value1 {
        case .ship: Self.ship(card, now: now, calendar: calendar)
        case .delist: Self.delist(card)
        case .reconnect: Self.reconnect(card)
        case .reviewDrafts: Self.drafts(card, calendar: calendar)
        case .staleListing: Self.stale(card)
        case nil: KindContent(systemImage: "sparkles")
        }
        systemImage = kind.systemImage
        iconTone = kind.iconTone
        status = kind.status
        facts = kind.facts
        // A status that says it already makes the detail a repeat.
        detail = card.detail == kind.status?.label ? nil : card.detail
    }

    /// What a card shows that depends on its kind.
    private struct KindContent {
        var systemImage: String
        var iconTone: StatusTone?
        var status: Badge?
        var facts: [Fact] = []
    }

    private static func ship(_ card: TodayCard, now: Date, calendar: Calendar) -> KindContent {
        var content = KindContent(systemImage: "shippingbox.fill")
        if let shipment = card.shipment {
            content.facts.append(shipBy(shipment, now: now, calendar: calendar))
            if let location = shipment.location {
                let text = location.label.map { "\(location.code) · \($0)" } ?? location.code
                content.facts.append(Fact(text: text, systemImage: "archivebox"))
            }
        }
        return content
    }

    private static func delist(_ card: TodayCard) -> KindContent {
        let status = card.delist.map { Badge(label: $0.statusDisplay.label, tone: StatusTone($0.statusDisplay.tone)) }
        return KindContent(systemImage: "tag.slash.fill", iconTone: .actionNeeded, status: status)
    }

    private static func reconnect(_ card: TodayCard) -> KindContent {
        var content = KindContent(systemImage: "link.badge.plus", iconTone: .actionNeeded)
        if let name = card.connection?.displayName {
            content.facts.append(Fact(text: name, systemImage: "person.crop.circle"))
        }
        return content
    }

    private static func drafts(_ card: TodayCard, calendar: Calendar) -> KindContent {
        var content = KindContent(systemImage: "square.and.pencil")
        if let drafts = card.drafts {
            content.facts.append(Fact(
                text: "Oldest from \(day(drafts.oldestCreatedAt, calendar: calendar))",
                systemImage: "calendar",
            ))
        }
        return content
    }

    private static func stale(_ card: TodayCard) -> KindContent {
        var content = KindContent(systemImage: "clock.arrow.circlepath", iconTone: .neutral)
        if let stale = card.staleListing {
            content.facts.append(Fact(
                text: stale.daysListed == 1 ? "Listed 1 day" : "Listed \(stale.daysListed) days",
                systemImage: "clock",
            ))
            let names = stale.marketplaces
                .map { TodayFormatting.marketplaceName($0.value1?.rawValue ?? $0.value2 ?? "") }
            if !names.isEmpty {
                content.facts.append(Fact(text: names.joined(separator: ", "), systemImage: "tag"))
            }
        }
        return content
    }

    private static func action(_ action: Components.Schemas.TodayAction) -> Action? {
        let destination: TodayDestination? = switch action.destination.value1 {
        case .item: action.itemId.map { .item(id: $0) }
        case .sale: action.saleId.map { .sale(id: $0) } ?? action.itemId.map { .item(id: $0) }
        case .marketplaces: .marketplaces
        case .drafts: .drafts
        case nil: action.itemId.map { .item(id: $0) }
        }
        return destination.map { Action(label: action.label, destination: $0) }
    }

    /// "Ship by today", "Ship by tomorrow", "Ship by Fri, Oct 30", "Overdue since Oct 24", or, with
    /// no ship-by date, when it sold.
    static func shipBy(_ shipment: Components.Schemas.TodayShipment, now: Date, calendar: Calendar) -> Fact {
        guard let shipBy = shipment.shipBy else {
            let sold = calendar.isDate(shipment.soldAt, inSameDayAs: now)
                ? "today" : day(shipment.soldAt, calendar: calendar)
            return Fact(text: "Sold \(sold)", systemImage: "calendar")
        }
        if shipBy < now {
            let text = "Overdue since \(day(shipBy, calendar: calendar))"
            return Fact(text: text, systemImage: "exclamationmark.circle", tone: .actionNeeded)
        }
        let text = if calendar.isDate(shipBy, inSameDayAs: now) {
            "Ship by today"
        } else if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now),
                  calendar.isDate(shipBy, inSameDayAs: tomorrow)
        {
            "Ship by tomorrow"
        } else {
            "Ship by \(day(shipBy, weekday: true, calendar: calendar))"
        }
        return Fact(text: text, systemImage: "calendar")
    }

    /// "Oct 24", or "Fri, Oct 30" with the weekday, in the calendar's time zone.
    private static func day(_ date: Date, weekday: Bool = false, calendar: Calendar) -> String {
        var style = Date.FormatStyle(calendar: calendar, timeZone: calendar.timeZone).month(.abbreviated).day()
        if weekday {
            style = style.weekday(.abbreviated)
        }
        return date.formatted(style)
    }
}

extension StatusTone {
    /// The design system's tone for a server tone; an unknown tone looks neutral.
    init(_ tone: Components.Schemas.StatusTone) {
        switch tone.value1 {
        case .success: self = .success
        case .inProgress: self = .inProgress
        case .checking: self = .checking
        case .failed: self = .failed
        case .actionNeeded: self = .actionNeeded
        case .neutral, nil: self = .neutral
        }
    }
}

/// How amounts and marketplaces read on the Today screen.
enum TodayFormatting {
    /// "$12.50" for 1250 cents of USD; whole dollars drop the cents ("$40").
    static func money(_ money: Money) -> String {
        let amount = Decimal(money.amountCents) / 100
        let whole = money.amountCents.isMultiple(of: 100)
        return amount.formatted(
            .currency(code: money.currency.rawValue).precision(.fractionLength(whole ? 0 : 2)),
        )
    }

    /// The marketplace's own spelling; an id this app does not know shows as sent.
    static func marketplaceName(_ id: String) -> String {
        switch id {
        case "ebay": "eBay"
        case "depop": "Depop"
        case "poshmark": "Poshmark"
        case "mercari": "Mercari"
        default: id
        }
    }
}
