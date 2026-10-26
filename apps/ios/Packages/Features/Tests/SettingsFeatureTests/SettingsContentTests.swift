import Core
import Foundation
import SettingsFeature
import Testing

struct SettingsContentTests {
    @Test
    func `shows only the version in plain words, and keeps the build's details for Diagnostics`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:3000"))
        let configuration = try AppConfiguration(
            environment: .dev,
            apiBaseURL: url,
            appGroupIdentifier: "group.com.listora.app.dev",
            supportEmail: "help@listora.example",
        )
        let content = SettingsContent(
            configuration: configuration,
            version: AppVersion(marketing: "1.0", build: "7"),
            installationID: "install-1",
        )
        #expect(content.version == "Listora 1.0")
        #expect(content.fullVersion == "1.0 (7)")
        #expect(content.supportEmail == "help@listora.example")
        #expect(content.diagnostics.map(\.value) == ["1.0 (7)", "Dev", "http://127.0.0.1:3000", "install-1"])
    }
}
