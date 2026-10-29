import Core
import Foundation
import Testing
@testable import PhoneExecutionFeature

/// A call's origins and cookie domains are cut to the marketplace's own sites as the app knows
/// them, whatever the server sends.
struct MarketplaceSitesTests {
    @Test
    func `keeps the marketplace's own sites`() {
        let input = MarketplaceSites().allowed(Self.call(
            origins: ["https://www.depop.com", "https://depop.com"],
            apiOrigins: ["https://webapi.depop.com"],
            cookieDomains: ["depop.com"],
        ), marketplace: "depop")

        #expect(input["origins"] as? [String] == ["https://www.depop.com", "https://depop.com"])
        #expect(input["apiOrigins"] as? [String] == ["https://webapi.depop.com"])
        #expect(input["cookieDomains"] as? [String] == ["depop.com"])
        // Everything else in the call is left as it was.
        #expect(input["name"] as? String == "create")
    }

    @Test
    func `drops any other site the server names`() {
        let input = MarketplaceSites().allowed(Self.call(
            origins: ["https://www.depop.com", "https://evil.example", "https://notdepop.com", "http://www.depop.com"],
            apiOrigins: ["https://webapi.depop.com", "https://collect.evil.example"],
            cookieDomains: ["depop.com", "evil.example", "com"],
        ), marketplace: "depop")

        #expect(input["origins"] as? [String] == ["https://www.depop.com"])
        #expect(input["apiOrigins"] as? [String] == ["https://webapi.depop.com"])
        #expect(input["cookieDomains"] as? [String] == ["depop.com"])
    }

    @Test
    func `keeps nothing of one marketplace for another, or for a marketplace it doesn't know`() {
        let depop = Self.call(
            origins: ["https://www.depop.com"],
            apiOrigins: ["https://webapi.depop.com"],
            cookieDomains: ["depop.com"],
        )
        for marketplace in ["poshmark", "unknown"] {
            let input = MarketplaceSites().allowed(depop, marketplace: marketplace)
            #expect((input["origins"] as? [String])?.isEmpty == true)
            #expect((input["apiOrigins"] as? [String])?.isEmpty == true)
            #expect((input["cookieDomains"] as? [String])?.isEmpty == true)
        }
    }

    @Test
    func `the fake sites stand in only in a Dev build`() throws {
        let local = Self.call(
            origins: ["http://127.0.0.1:4100", "http://127.0.0.1:4100/login", "http://192.168.1.20:4100"],
            apiOrigins: ["http://127.0.0.1:4100"],
            cookieDomains: ["127.0.0.1"],
        )
        let dev = try MarketplaceSites.for(AppConfiguration(
            environment: .dev, apiBaseURL: #require(URL(string: "http://127.0.0.1:3000")),
            appGroupIdentifier: "group.com.listora.app.dev",
        ))
        let devInput = dev.allowed(local, marketplace: "depop")
        #expect(devInput["origins"] as? [String] == ["http://127.0.0.1:4100"])
        #expect(devInput["apiOrigins"] as? [String] == ["http://127.0.0.1:4100"])
        #expect(devInput["cookieDomains"] as? [String] == ["127.0.0.1"])

        let prod = try MarketplaceSites.for(AppConfiguration(
            environment: .prod, apiBaseURL: #require(URL(string: "https://api.listora.example")),
            appGroupIdentifier: "group.com.listora.app",
        ))
        let prodInput = prod.allowed(local, marketplace: "depop")
        #expect((prodInput["origins"] as? [String])?.isEmpty == true)
        #expect((prodInput["cookieDomains"] as? [String])?.isEmpty == true)
    }

    @Test
    func `a server that sends no API origins still sends none`() {
        var call = Self.call(origins: ["https://poshmark.com"], apiOrigins: [], cookieDomains: ["poshmark.com"])
        call.removeValue(forKey: "apiOrigins")
        #expect(MarketplaceSites().allowed(call, marketplace: "poshmark")["apiOrigins"] == nil)
    }

    private static func call(origins: [String], apiOrigins: [String], cookieDomains: [String]) -> [String: Any] {
        [
            "runtimeVersion": 3,
            "name": "create",
            "origins": origins,
            "apiOrigins": apiOrigins,
            "cookieDomains": cookieDomains,
        ]
    }
}
