import Foundation
import Testing
@testable import Core

/// The marketplace sessions this phone keeps: each marketplace's own cookies, for one Listora
/// account only. The Keychain store needs an app's entitlements, which a package test has none
/// of; the phone UI tests (PhoneExecutionUITests) run with it.
struct MarketplaceSessionStoreTests {
    /// As WebKit reports a cookie: an expiry within the 400 days it allows, in whole seconds, and
    /// its own spelling of SameSite.
    private let depop = [StoredCookie(
        name: "access_token",
        value: "session-token",
        domain: ".depop.com",
        path: "/",
        expires: Date(timeIntervalSince1970: (Date().timeIntervalSince1970 + 86400).rounded(.down)),
        secure: true,
        httpOnly: true,
        sameSite: HTTPCookieStringPolicy.sameSiteLax.rawValue,
    )]

    @Test
    func `keeps each marketplace's session for the account signed in, and removes it for another`() {
        let store = InMemoryMarketplaceSessionStore()
        store.keep(onlyFor: "seller@listora.test")
        store.save(depop, for: "depop")
        #expect(store.cookies(for: "depop") == depop)
        #expect(store.cookies(for: "mercari").isEmpty)

        // The same account signing in again keeps its sessions.
        store.keep(onlyFor: "seller@listora.test")
        #expect(store.cookies(for: "depop") == depop)

        // Another account never acts in them.
        store.keep(onlyFor: "someone-else@listora.test")
        #expect(store.cookies(for: "depop").isEmpty)
    }

    @Test
    func `a session saved empty is removed`() {
        let store = InMemoryMarketplaceSessionStore(["depop": depop])
        store.save([], for: "depop")
        #expect(store.cookies(for: "depop").isEmpty)
    }

    @Test
    func `a cookie belongs to its domain and its subdomains, never a look-alike`() {
        let cookie = depop[0]
        #expect(cookie.belongs(to: ["depop.com"]))
        var www = cookie
        www.domain = "www.depop.com"
        #expect(www.belongs(to: ["depop.com"]))
        var lookAlike = cookie
        lookAlike.domain = "notdepop.com"
        #expect(!lookAlike.belongs(to: ["depop.com"]))
    }

    @Test
    func `a stored cookie goes back into a web view as it was`() throws {
        let cookie = try #require(depop[0].httpCookie)
        #expect(cookie.name == "access_token")
        #expect(cookie.domain == ".depop.com")
        #expect(cookie.isSecure)
        #expect(cookie.isHTTPOnly)
        #expect(StoredCookie(cookie) == depop[0])
    }
}
