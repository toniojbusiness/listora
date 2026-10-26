import Foundation
import Testing
@testable import Core

struct SignInLinkRuleTests {
    private let depop = SignInLinkRule(
        loginURL: URL(string: "https://www.depop.com/login/")!,
        domains: ["depop.com"],
    )
    /// The fake Depop site in development: http on 127.0.0.1 and its own port.
    private let standIn = SignInLinkRule(
        loginURL: URL(string: "http://127.0.0.1:4700/login/")!,
        domains: ["127.0.0.1"],
    )

    @Test(arguments: [
        "https://www.depop.com/login/magic-link/?token=abc123",
        "https://depop.com/login/magic-link/?token=abc123",
        "https://links.depop.com/ls/click?upn=abc",
        "HTTPS://WWW.DEPOP.COM/login/magic-link/?token=abc",
        "https://www.depop.com./login/magic-link/?token=abc",
        "https://www.depop.com:443/login/magic-link/?token=abc",
    ])
    func `accepts depops own links`(_ link: String) throws {
        #expect(try depop.accepts(#require(URL(string: link))))
    }

    @Test(arguments: [
        // Not https.
        "http://www.depop.com/login/magic-link/?token=abc",
        "javascript:alert(1)",
        "depop://login?token=abc",
        "file:///login/magic-link",
        // Look-alikes and other sites.
        "https://notdepop.com/login/magic-link/?token=abc",
        "https://depop.com.evil.example/login/magic-link/?token=abc",
        "https://www.depop.co/login/magic-link/?token=abc",
        "https://evil.example/?next=https://www.depop.com/login/",
        "https://www.depop.com@evil.example/login/",
        "https://user:pass@www.depop.com/login/",
        "https://www.depop.com:8443/login/magic-link/?token=abc",
        "https://www.poshmark.com/login",
        "https://127.0.0.1:4700/login/magic-link/?token=abc",
    ])
    func `refuses every other link`(_ link: String) throws {
        let url = try #require(URL(string: link))
        #expect(!depop.accepts(url))
    }

    @Test func `refuses an overlong link`() throws {
        let link = "https://www.depop.com/login/magic-link/?token=" + String(repeating: "a", count: 2100)
        #expect(try !depop.accepts(#require(URL(string: link))))
    }

    @Test func `accepts the stand in sites own scheme and port only`() throws {
        #expect(try standIn.accepts(#require(URL(string: "http://127.0.0.1:4700/login/magic-link/?token=a"))))
        #expect(try !standIn.accepts(#require(URL(string: "http://127.0.0.1:4800/login/magic-link/?token=a"))))
        #expect(try !standIn.accepts(#require(URL(string: "http://localhost:4700/login/magic-link/?token=a"))))
        // Production's https sign-in page never takes an http link.
        #expect(try !depop.accepts(#require(URL(string: "http://depop.com/login/"))))
    }

    @Test func `finds the link in pasted or shared text`() {
        let link = "https://www.depop.com/login/magic-link/?token=abc"
        #expect(depop.link(in: "  \(link)\n")?.absoluteString == link)
        #expect(depop.link(in: "Tap to log in: \(link) (expires in 15 minutes)")?.absoluteString == link)
        #expect(depop.link(in: "https://evil.example/ then \(link)")?.absoluteString == link)
        #expect(depop.link(in: "https://notdepop.com/login/magic-link/?token=abc") == nil)
        #expect(depop.link(in: "no link here") == nil)
        #expect(depop.link(in: "") == nil)
    }
}

struct SignInLinkHandoffTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let request = SignInLinkRequest(
        marketplace: "depop",
        name: "Depop",
        rule: SignInLinkRule(loginURL: URL(string: "https://www.depop.com/login/")!, domains: ["depop.com"]),
        expiresAt: Date(timeIntervalSince1970: 1_800_001_800),
    )
    private let link = "https://www.depop.com/login/magic-link/?token=abc"

    @Test func `a shared link reaches the waiting page once`() throws {
        let handoff = InMemorySignInLinkHandoff()
        handoff.expect(request)
        let shared = try SharedContent(urls: [#require(URL(string: link))])
        #expect(handoff.deliver(from: shared, now: now) == request)
        #expect(handoff.take(for: "depop", now: now)?.absoluteString == link)
        #expect(handoff.take(for: "depop", now: now) == nil)
    }

    @Test func `a link in shared text reaches the page`() {
        let handoff = InMemorySignInLinkHandoff()
        handoff.expect(request)
        let shared = SharedContent(text: "Log in to Depop: \(link)")
        #expect(handoff.deliver(from: shared, now: now) == request)
        #expect(handoff.take(for: "depop", now: now)?.absoluteString == link)
    }

    @Test func `nothing is delivered without A waiting page`() throws {
        let handoff = InMemorySignInLinkHandoff()
        #expect(try handoff.deliver(from: SharedContent(urls: [#require(URL(string: link))]), now: now) == nil)
        #expect(handoff.take(for: "depop", now: now) == nil)
    }

    @Test func `another sites link is not delivered`() throws {
        let handoff = InMemorySignInLinkHandoff()
        handoff.expect(request)
        let shared =
            try SharedContent(urls: [#require(URL(string: "https://notdepop.com/login/magic-link/?token=abc"))])
        #expect(handoff.deliver(from: shared, now: now) == nil)
        #expect(handoff.take(for: "depop", now: now) == nil)
    }

    @Test func `a lapsed request takes no link`() throws {
        let handoff = InMemorySignInLinkHandoff()
        handoff.expect(request)
        let later = request.expiresAt.addingTimeInterval(1)
        #expect(try handoff.deliver(from: SharedContent(urls: [#require(URL(string: link))]), now: later) == nil)
        try handoff.deliver(#require(URL(string: link)))
        #expect(handoff.take(for: "depop", now: later) == nil)
    }

    @Test func `another marketplaces page and A closed page take nothing`() throws {
        let handoff = InMemorySignInLinkHandoff()
        handoff.expect(request)
        try handoff.deliver(#require(URL(string: link)))
        #expect(handoff.take(for: "poshmark", now: now) == nil)
        handoff.expect(request)
        try handoff.deliver(#require(URL(string: link)))
        handoff.clear()
        #expect(handoff.expected(now: now) == nil)
        #expect(handoff.take(for: "depop", now: now) == nil)
    }

    @Test func `a link left by hand is checked again when taken`() throws {
        let handoff = InMemorySignInLinkHandoff()
        handoff.expect(request)
        try handoff.deliver(#require(URL(string: "https://evil.example/login")))
        #expect(handoff.take(for: "depop", now: now) == nil)
    }
}
