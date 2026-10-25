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

/// Account, marketplace connections, and app information. Dev builds also have a developer
/// sign-in; the real account (T-28, T-31) and API connection (T-16, T-25) sections come later.
/// `linkAccounts` is the Link accounts screen, which `AppFeature` composes in.
public struct SettingsView<LinkAccounts: View>: View {
    private let content: SettingsContent
    private let devSignIn: DevSignInModel?
    private let linkAccounts: LinkAccounts?

    public init(content: SettingsContent, devSignIn: DevSignInModel? = nil, linkAccounts: LinkAccounts) {
        self.content = content
        self.devSignIn = devSignIn
        self.linkAccounts = linkAccounts
    }

    public var body: some View {
        NavigationStack {
            List {
                if let devSignIn {
                    DevSignInSection(model: devSignIn)
                        .listRowBackground(Palette.surface.color)
                }
                if let linkAccounts {
                    Section("Marketplaces") {
                        NavigationLink {
                            linkAccounts
                        } label: {
                            Label("Link accounts", systemImage: "link")
                        }
                        .accessibilityIdentifier("settings.linkAccounts")
                    }
                    .listRowBackground(Palette.surface.color)
                }
                Section("About") {
                    row("Version", content.version, id: "settings.version")
                    row("Environment", content.environment, id: "settings.environment")
                    row("API", content.apiBaseURL, id: "settings.apiBaseURL")
                }
                .listRowBackground(Palette.surface.color)
            }
            .scrollContentBackground(.hidden)
            .background(Palette.background)
            .foregroundStyle(Palette.textPrimary)
            .navigationTitle("Settings")
        }
    }

    private func row(_ title: String, _ value: String, id: String) -> some View {
        LabeledContent {
            Text(value)
                .foregroundStyle(Palette.textSecondary)
                .textSelection(.enabled)
                .accessibilityIdentifier(id)
        } label: {
            Text(title)
        }
    }
}

extension SettingsView where LinkAccounts == EmptyView {
    /// Settings without the Link accounts screen.
    public init(content: SettingsContent, devSignIn: DevSignInModel? = nil) {
        self.content = content
        self.devSignIn = devSignIn
        linkAccounts = nil
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
            switch model.stage {
            case .enterEmail:
                TextField("Email", text: $model.email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("devSignIn.email")
                Button("Send code") { Task { await model.requestCode() } }
                    .disabled(!model.canRequestCode)
                    .accessibilityIdentifier("devSignIn.sendCode")
            case .enterCode:
                Text("Enter the code from the API's log for \(model.email).")
                    .foregroundStyle(Palette.textSecondary)
                TextField("6-digit code", text: $model.code)
                    .textContentType(.oneTimeCode)
                    .keyboardType(.numberPad)
                    .accessibilityIdentifier("devSignIn.code")
                Button("Sign in") { Task { await model.signIn() } }
                    .disabled(!model.canSignIn)
                    .accessibilityIdentifier("devSignIn.signIn")
                Button("Use a different email") { model.signOut() }
            case let .signedIn(email):
                LabeledContent("Signed in as") {
                    Text(email)
                        .foregroundStyle(Palette.textSecondary)
                        .accessibilityIdentifier("devSignIn.signedInEmail")
                }
                Button("Sign out", role: .destructive) { model.signOut() }
            }
            if let message = model.message {
                Text(message)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.danger)
            }
        } header: {
            Text("Developer sign-in")
        } footer: {
            Text("Dev builds only. Start the API with AUTH_DRIVER=dev.")
        }
        .onAppear { model.refresh() }
    }
}
