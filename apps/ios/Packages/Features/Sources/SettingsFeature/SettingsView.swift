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

/// Account, marketplace connections, and app information. Only the About section exists until
/// the account (T-28) and connection (T-16, T-25) tasks.
public struct SettingsView: View {
    private let content: SettingsContent

    public init(content: SettingsContent) {
        self.content = content
    }

    public var body: some View {
        NavigationStack {
            List {
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

#Preview {
    // swiftlint:disable:next force_try
    let configuration = try! AppConfiguration(environment: .dev, apiBaseURL: URL(string: "http://127.0.0.1:3000")!)
    SettingsView(content: SettingsContent(
        configuration: configuration,
        version: AppVersion(marketing: "1.0", build: "1"),
    ))
}
