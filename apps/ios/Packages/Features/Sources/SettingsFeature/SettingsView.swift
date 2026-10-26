import Core
import DesignSystem
import SwiftUI

/// What the Settings screen shows, derived from the build configuration.
public struct SettingsContent: Equatable, Sendable {
    public let environment: String
    public let apiBaseURL: String
    public let version: String

    public init(configuration: AppConfiguration, version: AppVersion) {
        environment = configuration.environment.displayName
        apiBaseURL = configuration.apiBaseURL.absoluteString
        self.version = version.description
    }
}

/// Who is signed in, and how to sign out. Settings opens only over the signed-in app; signing in
/// is the app's root screen while nobody is (SignInFeature).
public struct SettingsAccount {
    public let email: String
    public let signOut: @MainActor () -> Void

    public init(email: String, signOut: @escaping @MainActor () -> Void) {
        self.email = email
        self.signOut = signOut
    }
}

/// A screen Settings opens, also from elsewhere in the app (the connection banner opens
/// Marketplaces).
public enum SettingsDestination: Hashable, Sendable {
    case marketplaces
    case linkAccounts
    case deleteAccount
}

/// Account, marketplace connections, and app information, opened over the app from the gear in
/// the Today and Sales headers. The account section says who is signed in, signs out, and offers
/// account deletion (App Store Review Guideline 5.1.1(v)).
/// The Marketplaces and Link accounts screens come from the caller
/// (AppFeature), since a feature never imports another; so does `path`, so the caller can open
/// them.
public struct SettingsView<Marketplaces: View, LinkAccounts: View>: View {
    private let content: SettingsContent
    private let account: SettingsAccount?
    private let accountDeletion: AccountDeletionModel?
    private let marketplaces: Marketplaces?
    private let linkAccounts: LinkAccounts?
    /// The server's words for a connection that needs attention, shown on the Marketplaces row.
    private let marketplacesAttention: String?
    @Binding private var path: [SettingsDestination]
    /// Closes Settings, which opens over the app; nil shows no Done button.
    private let onDone: (@MainActor () -> Void)?

    public init(
        content: SettingsContent,
        account: SettingsAccount? = nil,
        accountDeletion: AccountDeletionModel? = nil,
        path: Binding<[SettingsDestination]>,
        marketplacesAttention: String? = nil,
        onDone: (@MainActor () -> Void)? = nil,
        @ViewBuilder marketplaces: () -> Marketplaces,
        @ViewBuilder linkAccounts: () -> LinkAccounts,
    ) {
        self.content = content
        self.account = account
        self.accountDeletion = accountDeletion
        _path = path
        self.marketplacesAttention = marketplacesAttention
        self.onDone = onDone
        self.marketplaces = marketplaces()
        self.linkAccounts = linkAccounts()
    }

    public var body: some View {
        NavigationStack(path: $path) {
            List {
                if marketplaces != nil || linkAccounts != nil {
                    Section {
                        if marketplaces != nil {
                            NavigationLink(value: SettingsDestination.marketplaces) {
                                ListRow(
                                    "Marketplaces",
                                    subtitle: "Connect eBay, and see how Listora works with each marketplace.",
                                    systemImage: "link",
                                ) {
                                    if let marketplacesAttention {
                                        StatusBadge(marketplacesAttention, tone: .actionNeeded)
                                            .accessibilityIdentifier("settings.marketplaces.attention")
                                    }
                                }
                            }
                            .accessibilityIdentifier("settings.marketplaces")
                        }
                        if linkAccounts != nil {
                            NavigationLink(value: SettingsDestination.linkAccounts) {
                                ListRow(
                                    "Link accounts",
                                    subtitle: "Sign in on Poshmark, Mercari, Depop, and eBay "
                                        + "for Listora to automate them.",
                                    systemImage: "person.badge.key",
                                )
                            }
                            .accessibilityIdentifier("settings.linkAccounts")
                        }
                    }
                    .listRowBackground(Palette.surface.color)
                }
                if account != nil || accountDeletion?.isSignedIn == true {
                    Section {
                        if let account {
                            ListRow("Signed in as") {
                                IconTile(systemImage: "person.crop.circle.badge.checkmark", tone: .success)
                            } trailing: {
                                Text(account.email)
                                    .foregroundStyle(Palette.textSecondary)
                                    // An address does not read well aloud: "Email", then the address.
                                    .accessibilityLabel("Email")
                                    .accessibilityValue(account.email)
                                    .accessibilityIdentifier("signIn.signedInEmail")
                            }
                            Button("Sign out", role: .destructive, action: account.signOut)
                                .buttonStyle(.listora(.destructiveText, size: .large))
                                .accessibilityIdentifier("signIn.signOut")
                        }
                        if accountDeletion?.isSignedIn == true {
                            NavigationLink(value: SettingsDestination.deleteAccount) {
                                ListRow(
                                    "Delete account",
                                    subtitle: "Remove your items, sales, and history from Listora.",
                                    systemImage: "person.crop.circle.badge.xmark",
                                )
                            }
                            .accessibilityIdentifier("settings.deleteAccount")
                        }
                    } header: {
                        SectionHeader("Account")
                    }
                    .listRowBackground(Palette.surface.color)
                }
                Section {
                    row("Version", content.version, systemImage: "info.circle", id: "settings.version")
                    row("Environment", content.environment, systemImage: "server.rack", id: "settings.environment")
                    row(
                        "API",
                        content.apiBaseURL,
                        systemImage: "network",
                        id: "settings.apiBaseURL",
                        spokenAs: "API address",
                    )
                } header: {
                    SectionHeader("About")
                }
                .listRowBackground(Palette.surface.color)
            }
            .scrollContentBackground(.hidden)
            .background(Palette.background)
            .foregroundStyle(Palette.textPrimary)
            .navigationTitle("Settings")
            .toolbar {
                if let onDone {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done", action: onDone)
                            .accessibilityIdentifier("settings.done")
                    }
                }
            }
            .navigationDestination(for: SettingsDestination.self) { destination in
                switch destination {
                case .marketplaces:
                    marketplaces
                case .linkAccounts:
                    linkAccounts
                case .deleteAccount:
                    if let accountDeletion {
                        DeleteAccountView(model: accountDeletion)
                    }
                }
            }
            .onAppear { accountDeletion?.refresh() }
            .onChange(of: account?.email) { accountDeletion?.refresh() }
        }
    }

    /// `spokenAs`: what VoiceOver calls a value that does not read well aloud (an address); the
    /// value itself follows.
    private func row(
        _ title: String,
        _ value: String,
        systemImage: String,
        id: String,
        spokenAs spokenLabel: String? = nil,
    ) -> some View {
        ListRow(title) {
            IconTile(systemImage: systemImage, tone: .neutral)
        } trailing: {
            Text(value)
                .font(Typography.body)
                .foregroundStyle(Palette.textSecondary)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel(spokenLabel ?? value)
                .accessibilityValue(spokenLabel == nil ? "" : value)
                .accessibilityIdentifier(id)
        }
        .accessibilityElement(children: .contain)
    }
}

extension SettingsView where Marketplaces == EmptyView, LinkAccounts == EmptyView {
    /// Settings without the Marketplaces and Link accounts screens.
    public init(content: SettingsContent, account: SettingsAccount? = nil) {
        self.content = content
        self.account = account
        accountDeletion = nil
        marketplaces = nil
        linkAccounts = nil
        marketplacesAttention = nil
        onDone = nil
        _path = .constant([])
    }
}

#Preview {
    // swiftlint:disable:next force_try
    let configuration = try! AppConfiguration(
        environment: .dev,
        apiBaseURL: URL(string: "http://127.0.0.1:3000")!,
        appGroupIdentifier: "group.com.listora.app.dev",
    )
    SettingsView(content: SettingsContent(
        configuration: configuration,
        version: AppVersion(marketing: "1.0", build: "1"),
    ))
}
