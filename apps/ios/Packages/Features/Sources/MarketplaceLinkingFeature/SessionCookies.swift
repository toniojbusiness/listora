import Foundation

/// One cookie of a marketplace's sign-in session, as the app hands it to Listora. Only the
/// cookie travels, never what the user typed: the password stays with the marketplace's page.
public struct CapturedCookie: Equatable, Sendable {
    public enum SameSite: String, Equatable, Sendable {
        case strict
        case lax
        case none
    }

    public let name: String
    public let value: String
    public let domain: String
    public let path: String
    /// Unix time in whole seconds; -1 for a cookie that lasts as long as the browser session.
    public let expires: Int64
    public let httpOnly: Bool
    public let secure: Bool
    public let sameSite: SameSite

    public init(
        name: String,
        value: String,
        domain: String,
        path: String,
        expires: Int64,
        httpOnly: Bool,
        secure: Bool,
        sameSite: SameSite,
    ) {
        self.name = name
        self.value = value
        self.domain = domain
        self.path = path
        self.expires = expires
        self.httpOnly = httpOnly
        self.secure = secure
        self.sameSite = sameSite
    }

    /// A cookie from the sign-in web view's cookie store. A site that set no SameSite gets
    /// `lax`, as browsers treat it.
    public init(_ cookie: HTTPCookie) {
        let sameSite: SameSite = switch cookie.sameSitePolicy {
        case HTTPCookieStringPolicy.sameSiteStrict: .strict
        case HTTPCookieStringPolicy.sameSiteLax: .lax
        default: .lax
        }
        self.init(
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path.isEmpty ? "/" : cookie.path,
            expires: cookie.expiresDate.map { max(1, Int64($0.timeIntervalSince1970.rounded(.down))) } ?? -1,
            httpOnly: cookie.isHTTPOnly,
            secure: cookie.isSecure,
            sameSite: sameSite,
        )
    }
}

/// Picks the marketplace's own cookies out of everything the sign-in web view holds.
public enum SessionCookies {
    /// The cookies on one of `domains` or a subdomain of one (`poshmark.com` covers
    /// `.poshmark.com` and `www.poshmark.com`, not `notposhmark.com`), still alive at `now`. A
    /// sign-in that went through another site (a single sign-on page, a CDN) leaves that site's
    /// cookies behind; the server refuses a session that carries any.
    public static func capture(
        _ cookies: [HTTPCookie],
        domains: [String],
        now: Date = Date(),
    ) -> [CapturedCookie] {
        let nowSeconds = Int64(now.timeIntervalSince1970)
        return cookies
            .map(CapturedCookie.init)
            .filter { onDomains($0.domain, domains) && ($0.expires == -1 || $0.expires > nowSeconds) }
            .sorted { ($0.domain, $0.path, $0.name) < ($1.domain, $1.path, $1.name) }
    }

    static func onDomains(_ cookieDomain: String, _ domains: [String]) -> Bool {
        let host = String(cookieDomain.lowercased().trimmingPrefix("."))
        return domains.contains { domain in
            let domain = domain.lowercased()
            return host == domain || host.hasSuffix(".\(domain)")
        }
    }
}
