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

/// Profile and settings, opened over the app from the avatar in the Today and Sales headers: the
/// seller's profile at the top, then only what a seller needs (their marketplaces, notifications
/// and delisting, sale emails, help, the legal documents, signing out, and deleting the account,
/// App Store Review Guideline 5.1.1(v)). The build's details are on the hidden Diagnostics screen.
public struct SettingsView: View {
    private let content: SettingsContent
    private let profile: ProfileModel?
    private let account: SettingsAccount?
    private let accountDeletion: AccountDeletionModel?
    /// Settings > People: invites; shown only to the account that may invite.
    let invites: InvitesModel?
    /// Settings > Description style: how Listora's AI writes the seller's Depop drafts.
    let descriptionStyle: DescriptionStyleModel?
    let screens: SettingsScreens
    /// What shows of each marketplace, and the owner's Test mode (docs/features/test-mode.md).
    let features: MarketplaceFeatures?
    /// The marketplaces' health, on the Linked marketplaces row.
    let marketplacesSummary: SettingsSummary?
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
        invites: InvitesModel? = nil,
        descriptionStyle: DescriptionStyleModel? = nil,
        screens: SettingsScreens = SettingsScreens(),
        features: MarketplaceFeatures? = nil,
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
        self.invites = invites
        self.descriptionStyle = descriptionStyle
        self.screens = screens
        self.features = features
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
                peopleSection
                testModeSection
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
            .task(id: account?.email) {
                if account != nil {
                    await invites?.load()
                }
            }
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
    private var sellingSection: some View {
        if showsSellingSection {
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
                if screens.packCheck != nil {
                    NavigationLink(value: SettingsDestination.packCheck) {
                        ListRow(
                            "Pack check",
                            subtitle: "Check each package's label before it ships",
                            systemImage: "shippingbox",
                        )
                    }
                    .accessibilityIdentifier("settings.packCheck")
                }
                descriptionStyleRow
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
        case .linkAccounts, .marketplaces, .imports, .listingRefresh, .notifications, .saleEmails, .packCheck:
            screens.screen(for: destination)
        case .people, .descriptionStyle:
            accountScreen(for: destination)
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
