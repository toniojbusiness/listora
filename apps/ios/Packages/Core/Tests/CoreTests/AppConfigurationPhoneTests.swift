import Core
import Foundation
import Testing

/// What the phone's own safeguards read from the build: the photo host it may fetch from, and
/// the keychain group only the app reads (docs/features/phone-execution.md).
struct AppConfigurationPhoneTests {
    private func info(environment: String = "prod", media: String? = nil, phoneGroup: String? = nil) -> [String: Any] {
        let api = environment == "dev" ? "http://127.0.0.1:3000" : "https://api.example.com"
        var info: [String: Any] = [
            AppConfiguration.InfoKey.environment: environment,
            AppConfiguration.InfoKey.apiBaseURL: api,
            AppConfiguration.InfoKey.appGroup: "group.com.listora.app",
            AppConfiguration.InfoKey.sessionKeychainGroup: "group.com.listora.app",
        ]
        info[AppConfiguration.InfoKey.mediaBaseURL] = media
        info[AppConfiguration.InfoKey.phoneKeychainGroup] = phoneGroup
        return info
    }

    @Test(arguments: [nil as String?, "", "$(MEDIA_BASE_URL)"])
    func `has no media host apart from the API unless the build names one`(value: String?) throws {
        #expect(try AppConfiguration(infoDictionary: info(media: value)).mediaBaseURL == nil)
    }

    @Test
    func `reads the media host`() throws {
        let config = try AppConfiguration(infoDictionary: info(media: "https://d111111abcdef8.cloudfront.net"))
        #expect(config.mediaBaseURL == URL(string: "https://d111111abcdef8.cloudfront.net"))
    }

    @Test
    func `rejects a media host on plain http outside Dev`() throws {
        #expect(throws: ConfigurationError.invalid(key: "ListoraMediaBaseURL", reason: "must use https outside Dev")) {
            try AppConfiguration(infoDictionary: info(media: "http://media.example.com"))
        }
        let dev = try AppConfiguration(infoDictionary: info(environment: "dev", media: "http://127.0.0.1:3000"))
        #expect(dev.mediaBaseURL == URL(string: "http://127.0.0.1:3000"))
    }

    @Test
    func `reads the app's own keychain group, which only personal device builds set`() throws {
        #expect(try AppConfiguration(infoDictionary: info()).phoneKeychainGroup == nil)
        #expect(try AppConfiguration(infoDictionary: info(phoneGroup: "")).phoneKeychainGroup == nil)
        let personal = try AppConfiguration(infoDictionary: info(phoneGroup: "ABCDE12345.com.example.listora"))
        #expect(personal.phoneKeychainGroup == "ABCDE12345.com.example.listora")
    }
}
