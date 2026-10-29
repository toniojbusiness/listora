import Core
import Foundation

/// Each marketplace's own sites, built into the app (docs/features/phone-execution.md#the-phone-runtime):
/// the origins its pages may load, the origins of its web API the pages read, and the domains
/// whose cookies make its session. A call's input names them too (the server's automation
/// profile), and the app keeps only what both name, so a server someone else controls can't send
/// a seller's session, or a page in it, anywhere else.
///
/// These match `PROFILES` in `packages/automation/src/profiles.ts` (a test there checks them).
/// A marketplace that moves its pages to a new domain needs an app update.
public struct MarketplaceSites: Sendable {
    struct Site: Equatable {
        let origins: Set<String>
        let apiOrigins: Set<String>
        let cookieDomains: Set<String>
    }

    static let compiled: [String: Site] = [
        "poshmark": Site(
            origins: ["https://poshmark.com", "https://www.poshmark.com"],
            apiOrigins: [],
            cookieDomains: ["poshmark.com"],
        ),
        "mercari": Site(
            origins: ["https://www.mercari.com", "https://mercari.com"],
            apiOrigins: [],
            cookieDomains: ["mercari.com"],
        ),
        "depop": Site(
            origins: ["https://www.depop.com", "https://depop.com"],
            apiOrigins: ["https://webapi.depop.com"],
            cookieDomains: ["depop.com"],
        ),
        "ebay": Site(
            origins: ["https://www.ebay.com", "https://ebay.com", "https://signin.ebay.com"],
            apiOrigins: [],
            cookieDomains: ["ebay.com"],
        ),
    ]

    /// Hosts that may stand in for any marketplace's site: the fake sites of a Dev build, on this
    /// Mac or the API's host. None in Staging and Prod.
    let localHosts: Set<String>

    public init(localHosts: Set<String> = []) {
        self.localHosts = localHosts
    }

    /// The real marketplaces only, plus the fake sites' hosts in a Dev build.
    public static func `for`(_ configuration: AppConfiguration) -> MarketplaceSites {
        guard configuration.environment == .dev else { return MarketplaceSites() }
        var hosts: Set = ["127.0.0.1", "localhost"]
        if let host = configuration.apiBaseURL.host() {
            hosts.insert(host)
        }
        return MarketplaceSites(localHosts: hosts)
    }

    /// The call's input with its origins, API origins, and cookie domains cut to those the app
    /// knows for `marketplace`, so the runtime and the page agree on them.
    func allowed(_ input: [String: Any], marketplace: String) -> [String: Any] {
        var input = input
        let site = Self.compiled[marketplace]
        input["origins"] = Self.strings(input["origins"]).filter {
            site?.origins.contains($0) == true || isLocal(origin: $0)
        }
        // A server older than API origins sends none, which the runtime reads as none.
        if input["apiOrigins"] != nil {
            input["apiOrigins"] = Self.strings(input["apiOrigins"]).filter {
                site?.apiOrigins.contains($0) == true || isLocal(origin: $0)
            }
        }
        input["cookieDomains"] = Self.strings(input["cookieDomains"]).filter {
            site?.cookieDomains.contains($0) == true || localHosts.contains($0)
        }
        return input
    }

    /// An http(s) origin on one of the local hosts, any port, with nothing after it.
    private func isLocal(origin: String) -> Bool {
        guard !localHosts.isEmpty, let url = URL(string: origin), let host = url.host(),
              url.scheme == "http" || url.scheme == "https"
        else { return false }
        let path = url.path()
        return localHosts.contains(host) && (path.isEmpty || path == "/") && url.query() == nil
            && url.user() == nil
    }

    private static func strings(_ value: Any?) -> [String] {
        (value as? [Any])?.compactMap { $0 as? String } ?? []
    }
}
