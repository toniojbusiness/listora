import Core
import Foundation
import Testing

struct AppConfigurationTests {
    private func info(
        environment: String? = "dev",
        url: String? = "http://127.0.0.1:3000",
        appGroup: String? = "group.com.listora.app.dev",
    ) -> [String: Any] {
        var info: [String: Any] = [:]
        info[AppConfiguration.InfoKey.environment] = environment
        info[AppConfiguration.InfoKey.apiBaseURL] = url
        info[AppConfiguration.InfoKey.appGroup] = appGroup
        return info
    }

    @Test
    func `parses a Dev configuration pointing at the local API`() throws {
        let config = try AppConfiguration(infoDictionary: info())
        #expect(config.environment == .dev)
        #expect(config.apiBaseURL == URL(string: "http://127.0.0.1:3000"))
        #expect(config.appGroupIdentifier == "group.com.listora.app.dev")
    }

    @Test
    func `requires the App Group the app shares with its Share Extension`() {
        #expect(throws: ConfigurationError.missing(key: "ListoraAppGroup")) {
            try AppConfiguration(infoDictionary: info(appGroup: nil))
        }
        // An unexpanded xcconfig variable is as good as missing.
        #expect(throws: ConfigurationError.missing(key: "ListoraAppGroup")) {
            try AppConfiguration(infoDictionary: info(appGroup: "$(APP_GROUP_IDENTIFIER)"))
        }
        for value in ["com.listora.app.dev", "group."] {
            #expect(throws: ConfigurationError.invalid(
                key: "ListoraAppGroup",
                reason: "must be an App Group identifier starting with group.",
            )) {
                try AppConfiguration(infoDictionary: info(appGroup: value))
            }
        }
    }

    @Test(arguments: ["staging", "prod"])
    func `accepts https outside Dev`(environment: String) throws {
        let config = try AppConfiguration(infoDictionary: info(
            environment: environment,
            url: "https://api.example.com/v1",
        ))
        #expect(config.environment.rawValue == environment)
        #expect(config.apiBaseURL.absoluteString == "https://api.example.com/v1")
    }

    @Test
    func `reads the Cognito app client the build signs in with`() throws {
        var dictionary = info(environment: "prod", url: "https://api.example.com")
        dictionary[AppConfiguration.InfoKey.cognitoRegion] = "us-east-1"
        dictionary[AppConfiguration.InfoKey.cognitoClientID] = "4example5client6id7abcdefgh"
        let config = try AppConfiguration(infoDictionary: dictionary)
        #expect(try config.cognito == CognitoConfiguration(
            region: "us-east-1",
            clientID: "4example5client6id7abcdefgh",
        ))
    }

    @Test(arguments: [nil as String?, "", "$(COGNITO_CLIENT_ID)"])
    func `has no sign-in without a Cognito app client, whatever the region`(clientID: String?) throws {
        var dictionary = info(environment: "prod", url: "https://api.example.com")
        dictionary[AppConfiguration.InfoKey.cognitoRegion] = "us-east-1"
        dictionary[AppConfiguration.InfoKey.cognitoClientID] = clientID
        #expect(try AppConfiguration(infoDictionary: dictionary).cognito == nil)
        #expect(try AppConfiguration(infoDictionary: info()).cognito == nil)
    }

    @Test
    func `needs the region of a Cognito app client, and rejects malformed values`() {
        var dictionary = info(environment: "prod", url: "https://api.example.com")
        dictionary[AppConfiguration.InfoKey.cognitoClientID] = "4example5client6id7abcdefgh"
        #expect(throws: ConfigurationError.missing(key: AppConfiguration.InfoKey.cognitoRegion)) {
            try AppConfiguration(infoDictionary: dictionary)
        }
        dictionary[AppConfiguration.InfoKey.cognitoRegion] = "Virginia"
        #expect(throws: ConfigurationError.invalid(
            key: AppConfiguration.InfoKey.cognitoRegion,
            reason: "must be an AWS region such as us-east-1",
        )) {
            try AppConfiguration(infoDictionary: dictionary)
        }
        dictionary[AppConfiguration.InfoKey.cognitoRegion] = "us-east-1"
        dictionary[AppConfiguration.InfoKey.cognitoClientID] = "not a client/id"
        #expect(throws: ConfigurationError.invalid(
            key: AppConfiguration.InfoKey.cognitoClientID,
            reason: "must be a Cognito app client id",
        )) {
            try AppConfiguration(infoDictionary: dictionary)
        }
    }

    @Test
    func `trims surrounding whitespace`() throws {
        let config = try AppConfiguration(infoDictionary: info(environment: " dev\n", url: " http://localhost:3000 "))
        #expect(config.apiBaseURL.absoluteString == "http://localhost:3000")
    }

    @Test(arguments: ["staging", "prod"])
    func `rejects plain http outside Dev`(environment: String) {
        #expect(throws: ConfigurationError.invalid(key: "ListoraAPIBaseURL", reason: "must use https outside Dev")) {
            try AppConfiguration(infoDictionary: info(environment: environment, url: "http://api.example.com"))
        }
    }

    @Test(arguments: [
        (nil as String?, "ListoraEnvironment"),
        ("", "ListoraEnvironment"),
        ("$(LISTORA_ENVIRONMENT)", "ListoraEnvironment"),
    ])
    func `reports a missing environment`(value: String?, key: String) {
        #expect(throws: ConfigurationError.missing(key: key)) {
            try AppConfiguration(infoDictionary: info(environment: value))
        }
    }

    @Test(arguments: [nil as String?, "", "   ", "$(API_BASE_URL)"])
    func `reports a missing API base URL`(value: String?) {
        #expect(throws: ConfigurationError.missing(key: "ListoraAPIBaseURL")) {
            try AppConfiguration(infoDictionary: info(url: value))
        }
    }

    @Test
    func `rejects an unknown environment`() {
        #expect(throws: ConfigurationError.invalid(
            key: "ListoraEnvironment",
            reason: "must be one of dev, staging, prod",
        )) {
            try AppConfiguration(infoDictionary: info(environment: "production"))
        }
    }

    @Test(arguments: ["127.0.0.1:3000", "/v1", "ftp://example.com", "http://", "file:///tmp/api"])
    func `rejects a URL that is not absolute http(s) with a host`(value: String) {
        #expect(throws: ConfigurationError.invalid(
            key: "ListoraAPIBaseURL",
            reason: "must be an absolute http(s) URL with a host",
        )) {
            try AppConfiguration(infoDictionary: info(url: value))
        }
    }

    @Test(arguments: ["http://127.0.0.1:3000?debug=1", "http://127.0.0.1:3000#top"])
    func `rejects a query or fragment`(value: String) {
        #expect(throws: ConfigurationError.invalid(
            key: "ListoraAPIBaseURL",
            reason: "must not have a query or fragment",
        )) {
            try AppConfiguration(infoDictionary: info(url: value))
        }
    }

    @Test(arguments: [
        ("dev", "http://user@127.0.0.1:3000"),
        ("dev", "http://:hunter2@127.0.0.1:3000"),
        ("prod", "https://user:hunter2@api.example.com"),
    ])
    func `rejects a user or password without echoing it`(environment: String, value: String) {
        do {
            _ = try AppConfiguration(infoDictionary: info(environment: environment, url: value))
            Issue.record("expected an error")
        } catch {
            #expect(error == .invalid(key: "ListoraAPIBaseURL", reason: "must not contain a user or password"))
            #expect(!error.description.contains("hunter2"))
            #expect(!error.description.contains("user@"))
        }
    }

    @Test
    func `rejects a value of the wrong type`() {
        var dictionary = info()
        dictionary[AppConfiguration.InfoKey.apiBaseURL] = 3000
        #expect(throws: ConfigurationError.invalid(key: "ListoraAPIBaseURL", reason: "must be a string")) {
            try AppConfiguration(infoDictionary: dictionary)
        }
    }

    @Test
    func `error messages name the key but never the value`() {
        let secretLooking = "https://user:hunter2@api.example.com?token=abc"
        do {
            _ = try AppConfiguration(infoDictionary: info(environment: "prod", url: secretLooking))
            Issue.record("expected an error")
        } catch {
            #expect(error.description.contains("ListoraAPIBaseURL"))
            #expect(!error.description.contains("hunter2"))
            #expect(!error.description.contains("token"))
        }
    }
}
