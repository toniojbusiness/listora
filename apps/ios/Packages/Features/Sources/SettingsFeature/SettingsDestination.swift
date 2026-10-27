import SwiftUI

/// The screens Settings opens that other features own; the caller (AppFeature) builds them, since
/// a feature never imports another. A nil screen hides its row.
public struct SettingsScreens {
    public var linkAccounts: (@MainActor () -> AnyView)?
    public var marketplaces: (@MainActor () -> AnyView)?
    public var notifications: (@MainActor () -> AnyView)?
    public var saleEmails: (@MainActor () -> AnyView)?

    /// The screen of one of the rows above; nil for every other destination.
    @MainActor
    func screen(for destination: SettingsDestination) -> AnyView? {
        switch destination {
        case .linkAccounts: linkAccounts?()
        case .marketplaces: marketplaces?()
        case .notifications: notifications?()
        case .saleEmails: saleEmails?()
        case .profile, .people, .help, .legal, .diagnostics, .deleteAccount: nil
        }
    }

    public init(
        linkAccounts: (@MainActor () -> AnyView)? = nil,
        marketplaces: (@MainActor () -> AnyView)? = nil,
        notifications: (@MainActor () -> AnyView)? = nil,
        saleEmails: (@MainActor () -> AnyView)? = nil,
    ) {
        self.linkAccounts = linkAccounts
        self.marketplaces = marketplaces
        self.notifications = notifications
        self.saleEmails = saleEmails
    }
}

/// A screen Settings opens, also from elsewhere in the app (the connection banner opens
/// Marketplaces, the first-run guide Link accounts).
public enum SettingsDestination: Hashable, Sendable {
    case profile
    case linkAccounts
    case marketplaces
    case notifications
    case saleEmails
    case people
    case help
    case legal(LegalDocument.Kind)
    case diagnostics
    case deleteAccount
}
