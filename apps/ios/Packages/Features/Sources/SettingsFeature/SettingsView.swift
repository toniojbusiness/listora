import Core
import DesignSystem
import SwiftUI

/// What the Settings screen shows about the build: the version in plain words, the support
/// address, and the details only the hidden Diagnostics screen shows.
public struct SettingsContent: Equatable, Sendable {
    /// One line of Diagnostics.
    public struct DiagnosticsRow: Equatable, Sendable {
        public let id: String
        public let label: String
        public let value: String
    }

    /// "Listora 0.1.0".
    public let version: String
    /// "0.1.0 (7)", for a support email's subject.
    public let fullVersion: String
    public let supportEmail: String?
    public let diagnostics: [DiagnosticsRow]

    public init(configuration: AppConfiguration, version: AppVersion, installationID: String) {
        self.version = "Listora \(version.marketing)"
        fullVersion = version.description
        supportEmail = configuration.supportEmail
        diagnostics = [
            DiagnosticsRow(id: "version", label: "Version", value: version.description),
            DiagnosticsRow(id: "environment", label: "Environment", value: configuration.environment.displayName),
            DiagnosticsRow(id: "apiBaseURL", label: "Server", value: configuration.apiBaseURL.absoluteString),
            DiagnosticsRow(id: "installation", label: "Installation", value: installationID),
        ]
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

/// A line under a Settings row in the server's words, such as the marketplaces' health.
public struct SettingsSummary: Equatable, Sendable {
    public let text: String
    /// True when the seller has something to do there: the row shows "Needs attention".
    public let needsAttention: Bool

    public init(_ text: String, needsAttention: Bool = false) {
        self.text = text
        self.needsAttention = needsAttention
    }
}

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
        case .profile, .help, .legal, .diagnostics, .deleteAccount: nil
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
    case help
    case legal(LegalDocument.Kind)
    case diagnostics
    case deleteAccount
}

/// Profile and settings, opened over the app from the avatar in the Today and Sales headers: the
/// seller's profile at the top, then only what a seller needs (their marketplaces, notifications
/// and delisting, sale emails, help, the legal documents, signing out, and deleting the account,
/// App Store Review Guideline 5.1.1(v)). The build's details are on the hidden Diagnostics screen.
public struct SettingsView: View {
    private let content: SettingsContent
    private let profile: ProfileModel?
    private let account: SettingsAccount?
    private let accountDeletion: AccountDeletionModel?
    private let screens: SettingsScreens
    /// The marketplaces' health, on the Linked marketplaces row.
    private let marketplacesSummary: SettingsSummary?
    /// The sale email forwarding's status, on the Sale emails row.
    private let saleEmailsSummary: SettingsSummary?
    private let legalDocument: @MainActor (LegalDocument.Kind) -> LegalDocument?
    @Binding private var path: [SettingsDestination]
    /// Closes Settings, which opens over the app; nil shows no Done button.
    private let onDone: (@MainActor () -> Void)?

    public init(
        content: SettingsContent,
        profile: ProfileModel? = nil,
        account: SettingsAccount? = nil,
        accountDeletion: AccountDeletionModel? = nil,
        screens: SettingsScreens = SettingsScreens(),
        marketplacesSummary: SettingsSummary? = nil,
        saleEmailsSummary: SettingsSummary? = nil,
        legalDocument: @escaping @MainActor (LegalDocument.Kind) -> LegalDocument? = { LegalDocument.bundled($0) },
        path: Binding<[SettingsDestination]>,
        onDone: (@MainActor () -> Void)? = nil,
    ) {
        self.content = content
        self.profile = profile
        self.account = account
        self.accountDeletion = accountDeletion
        self.screens = screens
        self.marketplacesSummary = marketplacesSummary
        self.saleEmailsSummary = saleEmailsSummary
        self.legalDocument = legalDocument
        _path = path
        self.onDone = onDone
    }

    public var body: some View {
        NavigationStack(path: $path) {
            List {
                profileSection
                marketplacesSection
                sellingSection
                supportSection
                accountSection
                versionFooter
            }
            .scrollContentBackground(.hidden)
            .background(Palette.background)
            .foregroundStyle(Palette.textPrimary)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let onDone {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done", action: onDone)
                            .accessibilityIdentifier("settings.done")
                    }
                }
            }
            .navigationDestination(for: SettingsDestination.self, destination: destination)
            .onAppear { accountDeletion?.refresh() }
            .onChange(of: account?.email) { accountDeletion?.refresh() }
            .task(id: account?.email) { await profile?.load() }
        }
    }

    // MARK: Sections

    /// The seller: their picture, name, business, and email; a tap edits them.
    @ViewBuilder
    private var profileSection: some View {
        if let account {
            Section {
                NavigationLink(value: SettingsDestination.profile) {
                    HStack(spacing: Spacing.md) {
                        Avatar(
                            initials: profile?.initials ?? Avatar.initials(for: [account.email]),
                            image: profile?.photo,
                            size: .large,
                        )
                        VStack(alignment: .leading, spacing: Spacing.xxs) {
                            Text(profile?.title ?? "Add your name")
                                .font(Typography.title3)
                                .foregroundStyle(Palette.textPrimary)
                                .accessibilityIdentifier("settings.profile.name")
                            if let business = profile?.profile?.businessName {
                                Text(business)
                                    .font(Typography.subheadline)
                                    .foregroundStyle(Palette.textPrimary)
                                    .accessibilityIdentifier("settings.profile.businessName")
                            }
                            Text(account.email)
                                .font(Typography.subheadline)
                                .foregroundStyle(Palette.textSecondary)
                                .lineLimit(2)
                                .truncationMode(.middle)
                                // An address does not read well aloud: "Email", then the address.
                                .accessibilityLabel("Email")
                                .accessibilityValue(account.email)
                                .accessibilityIdentifier("signIn.signedInEmail")
                            Text("Edit profile")
                                .font(Typography.smallEmphasis)
                                .foregroundStyle(Palette.brand)
                                .padding(.top, Spacing.xxs)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.vertical, Spacing.xs)
                }
                .accessibilityIdentifier("settings.profile")
            }
            .listRowBackground(Palette.surface.color)
        }
    }

    @ViewBuilder
    private var marketplacesSection: some View {
        if screens.linkAccounts != nil || screens.marketplaces != nil {
            Section {
                if screens.linkAccounts != nil {
                    NavigationLink(value: SettingsDestination.linkAccounts) {
                        ListRow(
                            "Linked marketplaces",
                            subtitle: marketplacesSummary?.text ?? "Poshmark, Mercari, Depop, and eBay",
                            systemImage: "person.badge.key",
                        ) {
                            if marketplacesSummary?.needsAttention == true {
                                StatusBadge("Needs attention", tone: .actionNeeded)
                                    .accessibilityIdentifier("settings.marketplaces.attention")
                            }
                        }
                    }
                    .accessibilityIdentifier("settings.linkAccounts")
                }
                if screens.marketplaces != nil {
                    NavigationLink(value: SettingsDestination.marketplaces) {
                        ListRow(
                            "How Listora connects",
                            subtitle: "Connect eBay, and check each marketplace's connection.",
                            systemImage: "link",
                        )
                    }
                    .accessibilityIdentifier("settings.marketplaces")
                }
            } header: {
                SectionHeader("Marketplaces")
            }
            .listRowBackground(Palette.surface.color)
        }
    }

    @ViewBuilder
    private var sellingSection: some View {
        if screens.notifications != nil || screens.saleEmails != nil {
            Section {
                if screens.notifications != nil {
                    NavigationLink(value: SettingsDestination.notifications) {
                        ListRow(
                            "Notifications",
                            subtitle: "The morning summary, and asking before delisting",
                            systemImage: "bell",
                        )
                    }
                    .accessibilityIdentifier("settings.notifications")
                }
                if screens.saleEmails != nil {
                    NavigationLink(value: SettingsDestination.saleEmails) {
                        ListRow(
                            "Sale emails",
                            subtitle: saleEmailsSummary?.text ?? "Catch sales from your marketplaces' emails",
                            systemImage: "envelope",
                        )
                    }
                    .accessibilityIdentifier("settings.saleEmails")
                }
            } header: {
                SectionHeader("Selling")
            }
            .listRowBackground(Palette.surface.color)
        }
    }

    private var supportSection: some View {
        Section {
            NavigationLink(value: SettingsDestination.help) {
                ListRow("Help and contact", systemImage: "questionmark.circle")
            }
            .accessibilityIdentifier("settings.help")
            NavigationLink(value: SettingsDestination.legal(.privacyPolicy)) {
                ListRow("Privacy policy", systemImage: "hand.raised")
            }
            .accessibilityIdentifier("settings.privacy")
            NavigationLink(value: SettingsDestination.legal(.termsOfService)) {
                ListRow("Terms of service", systemImage: "doc.text")
            }
            .accessibilityIdentifier("settings.terms")
        } header: {
            SectionHeader("Support")
        }
        .listRowBackground(Palette.surface.color)
    }

    @ViewBuilder
    private var accountSection: some View {
        if account != nil || accountDeletion?.isSignedIn == true {
            Section {
                if let account {
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
                            tone: .failed,
                        )
                    }
                    .accessibilityIdentifier("settings.deleteAccount")
                }
            } header: {
                SectionHeader("Account")
            }
            .listRowBackground(Palette.surface.color)
        }
    }
}

extension SettingsView {
    /// The version in plain words; a long press opens Diagnostics.
    private var versionFooter: some View {
        Section {
            EmptyView()
        } footer: {
            Text(content.version)
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
                .frame(maxWidth: .infinity, minHeight: Layout.minimumTapTarget)
                .contentShape(Rectangle())
                .onLongPressGesture { path.append(.diagnostics) }
                .accessibilityAction(named: "Show diagnostics") { path.append(.diagnostics) }
                .accessibilityIdentifier("settings.version")
        }
    }

    @ViewBuilder
    private func destination(_ destination: SettingsDestination) -> some View {
        switch destination {
        case .profile:
            if let profile {
                EditProfileView(model: profile)
            }
        case .linkAccounts, .marketplaces, .notifications, .saleEmails:
            screens.screen(for: destination)
        case .help:
            HelpView(supportEmail: content.supportEmail, version: content.fullVersion)
        case let .legal(kind):
            LegalDocumentView(kind: kind, document: legalDocument(kind))
        case .diagnostics:
            DiagnosticsView(rows: content.diagnostics)
        case .deleteAccount:
            if let accountDeletion {
                DeleteAccountView(model: accountDeletion)
            }
        }
    }
}

#Preview {
    // swiftlint:disable:next force_try
    let configuration = try! AppConfiguration(
        environment: .dev,
        apiBaseURL: URL(string: "http://127.0.0.1:3000")!,
        appGroupIdentifier: "group.com.listora.app.dev",
    )
    SettingsView(
        content: SettingsContent(
            configuration: configuration,
            version: AppVersion(marketing: "1.0", build: "1"),
            installationID: "preview",
        ),
        account: SettingsAccount(email: "sam@example.com") {},
        path: .constant([]),
    )
}
