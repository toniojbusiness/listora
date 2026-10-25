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

    /// What the user can do about the connection.
    public enum Action: Equatable, Sendable {
        case connect
        case reconnect
    }

    /// The marketplace id (`ebay`), also for marketplaces this app version does not know.
    public let id: String
    /// The marketplace the app can act on; nil for one added after this version.
    public let marketplace: Components.Schemas.KnownMarketplace?
    public let name: String
    public let statusLabel: String
    public let statusDetail: String?
    public let tone: Tone
    /// True when Listora works through the marketplace's API (not assisted).
    public let usesAPI: Bool
    public let action: Action?

    public init(connection: Components.Schemas.Connection) {
        let marketplace = connection.marketplace.value1
        id = marketplace?.rawValue ?? connection.marketplace.value2 ?? "unknown"
        self.marketplace = marketplace
        name = marketplace.map(Self.name(of:)) ?? id
        statusLabel = connection.statusDisplay.label
        statusDetail = connection.statusDisplay.detail
        tone = Self.tone(of: connection.statusDisplay.tone)
        usesAPI = connection.mode.value1 == .api
        action = Self.action(of: connection, known: marketplace != nil)
    }

    /// The button title for the row's action.
    public var actionTitle: String? {
        switch action {
        case .connect: "Connect \(name)"
        case .reconnect: "Reconnect \(name)"
        case nil: nil
        }
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

    /// Connecting needs a marketplace the app knows and an OAuth connect method; actions this
    /// version does not know are hidden.
    private static func action(of connection: Components.Schemas.Connection, known: Bool) -> Action? {
        guard known, connection.capabilities.connect.value1 == .oauth else { return nil }
        let actions = connection.availableActions.compactMap(\.value1)
        if actions.contains(.reconnect) {
            return .reconnect
        }
        if actions.contains(.connect) {
            return .connect
        }
        return nil
    }
}
