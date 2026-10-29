import Foundation
import Testing
@testable import PhoneExecutionFeature

/// Where the phone's web views and downloads may go (docs/features/phone-execution.md): photos
/// only from Listora's own hosts, a check handed to the seller only on the marketplace's own
/// domains and the sign-in providers, and the runtime's handler only for its own blank page.
struct PhonePageSafetyTests {
    private func url(_ string: String) throws -> URL {
        try #require(URL(string: string))
    }

    @Test
    func `fetches photos only from the API and the build's media host`() throws {
        let sources = try PhotoSources([
            url("https://api.listora.example"),
            url("https://d111111abcdef8.cloudfront.net"),
        ])

        #expect(try sources.allows(url("https://d111111abcdef8.cloudfront.net/listing/abc.jpg")))
        #expect(try sources.allows(url("https://api.listora.example/v1/storage/public/abc.jpg")))
        #expect(try !sources.allows(url("https://another.cloudfront.net/abc.jpg")))
        #expect(try !sources.allows(url("http://d111111abcdef8.cloudfront.net/abc.jpg")), "never over plain http")
        #expect(try !sources.allows(url("https://d111111abcdef8.cloudfront.net:8443/abc.jpg")))
        #expect(try !sources.allows(url("http://192.168.1.1/admin.jpg")))
        #expect(try !sources.allows(url("http://localhost:3000/abc.jpg")))
        #expect(try !sources.allows(url("file:///etc/hosts")))
    }

    @Test
    func `fetches over plain http only from a Dev build's own local API`() throws {
        let sources = try PhotoSources([url("http://127.0.0.1:3000")])

        #expect(try sources.allows(url("http://127.0.0.1:3000/v1/storage/public/abc.jpg")))
        #expect(try !sources.allows(url("http://127.0.0.1:8080/abc.jpg")))
        #expect(try !sources.allows(url("http://localhost:3000/abc.jpg")))
    }

    @Test
    func `a handed-off check stays on the marketplace's own domains and its sign-in providers`() throws {
        let domains = ["depop.com"]

        #expect(try HandOffPolicy.allows(url("https://www.depop.com/login/"), domains: domains))
        #expect(try HandOffPolicy.allows(url("https://depop.com/"), domains: domains))
        #expect(try HandOffPolicy.allows(url("https://accounts.google.com/o/oauth2/auth"), domains: domains))
        #expect(try HandOffPolicy.allows(url("https://appleid.apple.com/auth/authorize"), domains: domains))
        #expect(try !HandOffPolicy.allows(url("https://notdepop.com/login"), domains: domains))
        #expect(try !HandOffPolicy.allows(url("https://depop.com.evil.example/login"), domains: domains))
        #expect(try !HandOffPolicy.allows(url("http://www.depop.com/login"), domains: domains), "never over plain http")
        #expect(try !HandOffPolicy.allows(url("https://accounts.google.com.evil.example/"), domains: domains))
    }

    @Test
    func `the runtime's handler answers only its own blank page`() throws {
        #expect(RuntimeLane.isRuntimePage(nil))
        #expect(try RuntimeLane.isRuntimePage(url("about:blank")))
        #expect(try !RuntimeLane.isRuntimePage(url("https://www.depop.com/")))
        #expect(try !RuntimeLane.isRuntimePage(url("http://127.0.0.1:3000/")))
        #expect(try !RuntimeLane.isRuntimePage(url("data:text/html,hi")))
    }
}
