import Foundation
import Testing
@testable import Core

/// The marketplace sessions this phone keeps: each marketplace's own cookies, for one Listora
/// account only.
struct MarketplaceSessionStoreTests {
    private let depop = [StoredCookie(
        name: "access_token",
        value: "session-token",
        domain: ".depop.com",
        path: "/",
        expires: Date(timeIntervalSince1970: 1_900_000_000),
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
    )]

    @Test(arguments: [false, true])
    func `keeps each marketplace's session for the account signed in, and removes it for another`(keychain: Bool) {
        let store: any MarketplaceSessionStore = keychain
            ? KeychainMarketplaceSessionStore(service: "com.listora.tests.sessions.\(UUID().uuidString)")
            : InMemoryMarketplaceSessionStore()
        defer { store.removeAll() }
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
