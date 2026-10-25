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

/// A screen Settings opens, also from elsewhere in the app (the connection banner opens
/// Marketplaces).
public enum SettingsDestination: Hashable, Sendable {
    case marketplaces
    case linkAccounts
    case deleteAccount
}

/// Account, marketplace connections, and app information, opened over the app from the gear in
/// the Today and Sales headers. The account section signs in: with an emailed code from the
/// environment's user pool, or in Dev builds with the developer sign-in against the local API;
/// while someone is signed in, it offers account deletion (App Store Review Guideline 5.1.1(v)).
/// The Marketplaces and Link accounts screens come from the caller
/// (AppFeature), since a feature never imports another; so does `path`, so the caller can open
/// them.
public struct SettingsView<Marketplaces: View, LinkAccounts: View>: View {
    private let content: SettingsContent
    private let signIn: SignInModel?
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
        signIn: SignInModel? = nil,
        accountDeletion: AccountDeletionModel? = nil,
        path: Binding<[SettingsDestination]>,
        marketplacesAttention: String? = nil,
        onDone: (@MainActor () -> Void)? = nil,
        @ViewBuilder marketplaces: () -> Marketplaces,
        @ViewBuilder linkAccounts: () -> LinkAccounts,
    ) {
        self.content = content
        self.signIn = signIn
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
                if let signIn {
                    SignInSection(model: signIn)
                        .listRowBackground(Palette.surface.color)
                }
                if let accountDeletion, accountDeletion.isSignedIn {
                    Section {
                        NavigationLink(value: SettingsDestination.deleteAccount) {
                            ListRow(
                                "Delete account",
                                subtitle: "Remove your items, sales, and history from Listora.",
                                systemImage: "person.crop.circle.badge.xmark",
                            )
                        }
                        .accessibilityIdentifier("settings.deleteAccount")
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
            .onChange(of: signIn?.stage) { accountDeletion?.refresh() }
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
    public init(content: SettingsContent, signIn: SignInModel? = nil) {
        self.content = content
        self.signIn = signIn
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

/// Signing in: the email, then the code. The developer sign-in reads its code from the local API's
/// log; the email-code sign-in gets it by email from the environment's user pool.
struct SignInSection: View {
    @Bindable var model: SignInModel

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: Spacing.md) {
                switch model.stage {
                case .unavailable:
                    Banner(
                        "This build can't sign in: it has no Cognito app client (COGNITO_CLIENT_ID in its xcconfig).",
                        tone: .failed,
                    )
                    .accessibilityIdentifier("signIn.unavailable")
                case .enterEmail:
                    ListoraTextField("Email", hint: emailHint) {
                        TextField(
                            "Email",
                            text: $model.email,
                            prompt: Text("you@example.com").foregroundStyle(Palette.textSecondary),
                        )
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.send)
                        .onSubmit {
                            if model.canRequestCode {
                                Task { await model.requestCode() }
                            }
                        }
                        .accessibilityIdentifier("signIn.email")
                    }
                    Button(model.kind == .developer ? "Send code" : "Email me a code") {
                        Task { await model.requestCode() }
                    }
                    .buttonStyle(.listoraPrimary)
                    .disabled(!model.canRequestCode)
                    .loading(model.isWorking)
                    .accessibilityIdentifier("signIn.sendCode")
                case .enterCode:
                    ListoraTextField("Code", hint: codeHint) {
                        TextField(
                            "Code",
                            text: $model.code,
                            prompt: Text("123456").foregroundStyle(Palette.textSecondary),
                        )
                        .textContentType(.oneTimeCode)
                        .keyboardType(.numberPad)
                        .accessibilityIdentifier("signIn.code")
                    }
                    Button("Sign in") { Task { await model.signIn() } }
                        .buttonStyle(.listoraPrimary)
                        .disabled(!model.canSignIn)
                        .loading(model.isWorking)
                        .accessibilityIdentifier("signIn.signIn")
                    Button("Send a new code") { Task { await model.requestCode() } }
                        .buttonStyle(.listoraTertiary)
                        .disabled(model.isWorking)
                        .accessibilityIdentifier("signIn.resend")
                    Button("Use a different email") { model.startOver() }
                        .buttonStyle(.listoraTertiary)
                        .disabled(model.isWorking)
                case let .signedIn(email):
                    ListRow("Signed in as") {
                        IconTile(systemImage: "person.crop.circle.badge.checkmark", tone: .success)
                    } trailing: {
                        Text(email)
                            .foregroundStyle(Palette.textSecondary)
                            .accessibilityIdentifier("signIn.signedInEmail")
                    }
                    Button("Sign out", role: .destructive) { model.signOut() }
                        .buttonStyle(.listora(.destructiveText, size: .large))
                        .accessibilityIdentifier("signIn.signOut")
                }
                if let message = model.message {
                    Banner(message, tone: .failed)
                        .accessibilityIdentifier("signIn.message")
                }
            }
            .padding(.vertical, Spacing.xs)
        } header: {
            SectionHeader(model.kind == .developer ? "Developer sign-in" : "Account")
        }
        .onAppear { model.refresh() }
    }

    private var emailHint: String {
        model.kind == .developer
            ? "Dev builds only. Start the API with AUTH_DRIVER=dev."
            : "We'll email you a code to sign in. No password needed."
    }

    private var codeHint: String {
        model.kind == .developer
            ? "Enter the code from the API's log for \(model.email)."
            : "Enter the code we emailed to \(model.email). It works for 10 minutes."
    }
}
