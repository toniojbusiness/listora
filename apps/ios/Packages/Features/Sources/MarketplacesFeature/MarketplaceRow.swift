import Foundation
import ListoraAPI

/// One marketplace on the Marketplaces screen, as the server describes its connection. The
/// status text is the server's `statusDisplay`, shown as given: the app never decides on its own
/// that a marketplace is connected.
public struct MarketplaceRow: Identifiable, Equatable, Sendable {
    /// How a status is styled; an unknown tone looks neutral.
    public enum Tone: Equatable, Sendable {
        case success
        case inProgress
        case checking
        case failed
        case actionNeeded
        case neutral
    }

    /// How Listora works with the marketplace for this account.
    public enum Mode: Equatable, Sendable {
        /// Through the marketplace's official API, confirmed by reading it back.
        case api
        /// In the marketplace's website, in a browser session the seller linked.
        case automation
        /// Listora prepares the work; the seller does the last step in the marketplace's app.
        case assisted
        /// A mode added after this app version; the screen shows no mode for it.
        case other
    }

    /// What the user can do about the connection.
    public enum Action: Equatable, Sendable {
        case connect
        case reconnect
        /// Ask the server to check the connection now ("Retry check").
        case check
    }

    /// The marketplace id (`ebay`), also for marketplaces this app version does not know.
    public let id: String
    /// The marketplace the app can act on; nil for one added after this version.
    public let marketplace: Components.Schemas.KnownMarketplace?
    public let name: String
    public let statusLabel: String
    public let statusDetail: String?
    public let tone: Tone
    public let mode: Mode
    /// When the marketplace last accepted Listora's access (the last successful check).
    public let lastOkAt: Date?
    /// What the user can do now, the main action first.
    public let actions: [Action]

    public init(connection: Components.Schemas.Connection) {
        let marketplace = connection.marketplace.value1
        id = marketplace?.rawValue ?? connection.marketplace.value2 ?? "unknown"
        self.marketplace = marketplace
        name = marketplace.map(Self.name(of:)) ?? id
        statusLabel = connection.statusDisplay.label
        statusDetail = connection.statusDisplay.detail
        tone = Self.tone(of: connection.statusDisplay.tone)
        mode = Self.mode(of: connection.mode)
        lastOkAt = connection.lastOkAt
        actions = Self.actions(of: connection, known: marketplace != nil)
    }

    /// True when Listora works through the marketplace's API.
    public var usesAPI: Bool {
        mode == .api
    }

    /// The main action, if any.
    public var action: Action? {
        actions.first
    }

    /// The mode in a word, for the card's chip; nil for a mode this version does not know.
    public var modeLabel: String? {
        switch mode {
        case .api: "API"
        case .automation: "Automation"
        case .assisted: "Assisted"
        case .other: nil
        }
    }

    /// The button title for an action.
    public func title(for action: Action) -> String {
        switch action {
        case .connect: "Connect \(name)"
        case .reconnect: "Reconnect \(name)"
        case .check: "Retry check"
        }
    }

    /// The button title for the main action.
    public var actionTitle: String? {
        action.map(title(for:))
    }

    static func name(of marketplace: Components.Schemas.KnownMarketplace) -> String {
        switch marketplace {
        case .ebay: "eBay"
        case .depop: "Depop"
        case .poshmark: "Poshmark"
        case .mercari: "Mercari"
        }
    }

    private static func tone(of tone: Components.Schemas.StatusTone) -> Tone {
        switch tone.value1 {
        case .success: .success
        case .inProgress: .inProgress
        case .checking: .checking
        case .failed: .failed
        case .actionNeeded: .actionNeeded
        case .neutral, nil: .neutral
        }
    }

    private static func mode(of mode: Components.Schemas.IntegrationMode) -> Mode {
        switch mode.value1 {
        case .api: .api
        case .automation: .automation
        case .assisted: .assisted
        case nil: .other
        }
    }

    /// The server's actions in its order, without the ones this version cannot do: connecting
    /// needs a marketplace the app knows and an OAuth connect method, and unknown actions are
    /// hidden. Reconnecting replaces connecting when the server offers both.
    private static func actions(of connection: Components.Schemas.Connection, known: Bool) -> [Action] {
        guard known else { return [] }
        let oauth = connection.capabilities.connect.value1 == .oauth
        let offered = connection.availableActions.compactMap(\.value1)
        return offered.compactMap { action in
            switch action {
            case .connect: oauth && !offered.contains(.reconnect) ? .connect : nil
            case .reconnect: oauth ? .reconnect : nil
            case .check: .check
            }
        }
    }
}
