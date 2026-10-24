import Core
import Foundation
import SettingsFeature
import Testing

struct SettingsContentTests {
    @Test
    func `shows the environment, API base URL, and version of the build`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:3000"))
        let configuration = try AppConfiguration(environment: .dev, apiBaseURL: url)
        let content = SettingsContent(configuration: configuration, version: AppVersion(marketing: "1.0", build: "7"))
        #expect(content.environment == "Dev")
        #expect(content.apiBaseURL == "http://127.0.0.1:3000")
        #expect(content.version == "1.0 (7)")
    }
}
