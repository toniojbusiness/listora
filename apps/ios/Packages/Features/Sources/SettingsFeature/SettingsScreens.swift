import SwiftUI

/// The screens Settings opens that other features own; the caller (AppFeature) builds them, since
/// a feature never imports another. A nil screen hides its row.
public struct SettingsScreens {
    public var linkAccounts: (@MainActor () -> AnyView)?
    public var marketplaces: (@MainActor () -> AnyView)?
    /// Import listings: bring the listings a seller already has into Listora.
    public var imports: (@MainActor () -> AnyView)?
    public var notifications: (@MainActor () -> AnyView)?
    public var saleEmails: (@MainActor () -> AnyView)?
    public var packCheck: (@MainActor () -> AnyView)?

    /// The screen of one of the rows above; nil for every other destination.
    @MainActor
    func screen(for destination: SettingsDestination) -> AnyView? {
        switch destination {
        case .linkAccounts: linkAccounts?()
        case .marketplaces: marketplaces?()
        case .imports: imports?()
        case .notifications: notifications?()
        case .saleEmails: saleEmails?()
        case .packCheck: packCheck?()
        case .profile, .descriptionStyle, .people, .help, .legal, .diagnostics, .deleteAccount: nil
        }
    }

    public init(
        linkAccounts: (@MainActor () -> AnyView)? = nil,
        marketplaces: (@MainActor () -> AnyView)? = nil,
        imports: (@MainActor () -> AnyView)? = nil,
        notifications: (@MainActor () -> AnyView)? = nil,
        saleEmails: (@MainActor () -> AnyView)? = nil,
        packCheck: (@MainActor () -> AnyView)? = nil,
    ) {
        self.linkAccounts = linkAccounts
        self.marketplaces = marketplaces
        self.imports = imports
        self.notifications = notifications
        self.saleEmails = saleEmails
        self.packCheck = packCheck
    }
}

/// A screen Settings opens, also from elsewhere in the app (the connection banner opens
/// Marketplaces, the first-run guide Link accounts).
public enum SettingsDestination: Hashable, Sendable {
    case profile
    case linkAccounts
    case marketplaces
    case imports
    case notifications
    case saleEmails
    case packCheck
    case descriptionStyle
    case people
    case help
    case legal(LegalDocument.Kind)
    case diagnostics
    case deleteAccount
}
