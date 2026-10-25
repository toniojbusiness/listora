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
}

/// Account, marketplace connections, and app information. Dev builds also have a developer
/// sign-in; the real account section (T-28, T-31) comes later. The Marketplaces and Link accounts
/// screens come from the caller (AppFeature), since a feature never imports another; so does
/// `path`, so the caller can open them.
public struct SettingsView<Marketplaces: View, LinkAccounts: View>: View {
    private let content: SettingsContent
    private let devSignIn: DevSignInModel?
    private let devPalette: Binding<PaletteTheme.Key>?
    private let marketplaces: Marketplaces?
    private let linkAccounts: LinkAccounts?
    /// The server's words for a connection that needs attention, shown on the Marketplaces row.
    private let marketplacesAttention: String?
    @Binding private var path: [SettingsDestination]

    /// `devPalette`: Dev builds only, the palette theme the app draws in.
    public init(
        content: SettingsContent,
        devSignIn: DevSignInModel? = nil,
        path: Binding<[SettingsDestination]>,
        marketplacesAttention: String? = nil,
        devPalette: Binding<PaletteTheme.Key>? = nil,
        @ViewBuilder marketplaces: () -> Marketplaces,
        @ViewBuilder linkAccounts: () -> LinkAccounts,
    ) {
        self.content = content
        self.devSignIn = devSignIn
        _path = path
        self.marketplacesAttention = marketplacesAttention
        self.devPalette = devPalette
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
                                    subtitle: "Sign in on Poshmark, Mercari, and Depop for Listora to automate them.",
                                    systemImage: "person.badge.key",
                                )
                            }
                            .accessibilityIdentifier("settings.linkAccounts")
                        }
                    }
                    .listRowBackground(Palette.surface.color)
                }
                if let devSignIn {
                    DevSignInSection(model: devSignIn)
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
                // Last, so the About rows stay where they were.
                if let devPalette {
                    DevPaletteSection(selection: devPalette)
                        .listRowBackground(Palette.surface.color)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.background)
            .foregroundStyle(Palette.textPrimary)
            .navigationTitle("Settings")
            .navigationDestination(for: SettingsDestination.self) { destination in
                switch destination {
                case .marketplaces:
                    marketplaces
                case .linkAccounts:
                    linkAccounts
                }
            }
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
    public init(content: SettingsContent, devSignIn: DevSignInModel? = nil) {
        self.content = content
        self.devSignIn = devSignIn
        devPalette = nil
        marketplaces = nil
        linkAccounts = nil
        marketplacesAttention = nil
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

/// Sign in against the local API's dev auth driver: the code appears in the API's log.
struct DevSignInSection: View {
    @Bindable var model: DevSignInModel

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: Spacing.md) {
                switch model.stage {
                case .enterEmail:
                    ListoraTextField("Email", hint: "Dev builds only. Start the API with AUTH_DRIVER=dev.") {
                        TextField(
                            "Email",
                            text: $model.email,
                            prompt: Text("you@example.com").foregroundStyle(Palette.textSecondary),
                        )
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("devSignIn.email")
                    }
                    Button("Send code") { Task { await model.requestCode() } }
                        .buttonStyle(.listoraPrimary)
                        .disabled(!model.canRequestCode)
                        .loading(model.isWorking)
                        .accessibilityIdentifier("devSignIn.sendCode")
                case .enterCode:
                    ListoraTextField(
                        "6-digit code",
                        hint: "Enter the code from the API's log for \(model.email).",
                    ) {
                        TextField(
                            "6-digit code",
                            text: $model.code,
                            prompt: Text("123456").foregroundStyle(Palette.textSecondary),
                        )
                        .textContentType(.oneTimeCode)
                        .keyboardType(.numberPad)
                        .accessibilityIdentifier("devSignIn.code")
                    }
                    Button("Sign in") { Task { await model.signIn() } }
                        .buttonStyle(.listoraPrimary)
                        .disabled(!model.canSignIn)
                        .loading(model.isWorking)
                        .accessibilityIdentifier("devSignIn.signIn")
                    Button("Use a different email") { model.signOut() }
                        .buttonStyle(.listoraTertiary)
                case let .signedIn(email):
                    ListRow("Signed in as") {
                        IconTile(systemImage: "person.crop.circle.badge.checkmark", tone: .success)
                    } trailing: {
                        Text(email)
                            .foregroundStyle(Palette.textSecondary)
                            .accessibilityIdentifier("devSignIn.signedInEmail")
                    }
                    Button("Sign out", role: .destructive) { model.signOut() }
                        .buttonStyle(.listora(.destructiveText, size: .large))
                }
                if let message = model.message {
                    Banner(message, tone: .failed)
                }
            }
            .padding(.vertical, Spacing.xs)
        } header: {
            SectionHeader("Developer sign-in")
        }
        .onAppear { model.refresh() }
    }
}
