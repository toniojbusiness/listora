import Foundation

/// The marketplaces whose listing URLs Listora recognizes.
public enum ListingMarketplace: String, CaseIterable, Sendable {
    case ebay
    case depop
    case poshmark
    case mercari

    public var displayName: String {
        switch self {
        case .ebay: "eBay"
        case .depop: "Depop"
        case .poshmark: "Poshmark"
        case .mercari: "Mercari"
        }
    }
}

/// A marketplace listing named by a URL.
public struct ListingURL: Equatable, Sendable {
    public let marketplace: ListingMarketplace
    /// The marketplace's public listing id, or nil for a share short link (`posh.mk/...`), whose
    /// listing only the marketplace can resolve.
    public let listingId: String?
    /// The form that is stored and opened: https, no query or fragment, a stable host.
    public let canonicalURL: URL

    public init(marketplace: ListingMarketplace, listingId: String?, canonicalURL: URL) {
        self.marketplace = marketplace
        self.listingId = listingId
        self.canonicalURL = canonicalURL
    }

    public var isShortLink: Bool {
        listingId == nil
    }
}

/// Recognizes a marketplace listing from its URL, purely from the text: nothing is fetched.
///
/// The server parses the same URLs (`packages/shared/src/listing-url.ts`) and has the last word;
/// this copy lets the Share Extension say at once what was shared. Both are tested against
/// `packages/shared/fixtures/listing-urls.json`, so change them together.
public enum ListingURLParse: Equatable, Sendable {
    case listing(ListingURL)
    /// A page of a supported marketplace that is not a single listing (a closet, a search).
    case notListing(ListingMarketplace)
    /// Not a supported marketplace URL.
    case unsupported

    public init(_ text: String) {
        self = Self.parse(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    public init(_ url: URL) {
        self.init(url.absoluteString)
    }

    private static func parse(_ text: String) -> Self {
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              let host = url.host(percentEncoded: false)?.lowercased(), !host.isEmpty
        else { return .unsupported }
        // A URL with credentials or an unusual port is not one a marketplace shares.
        guard url.user() == nil, url.password() == nil else { return .unsupported }
        if let port = url.port, port != (scheme == "https" ? 443 : 80) {
            return .unsupported
        }

        let path = url.path(percentEncoded: true)
        for rule in rules {
            if rule.hosts.contains(host) {
                guard let (listingId, canonical) = rule.listing(path), let canonicalURL = URL(string: canonical) else {
                    return .notListing(rule.marketplace)
                }
                return .listing(ListingURL(
                    marketplace: rule.marketplace,
                    listingId: listingId,
                    canonicalURL: canonicalURL,
                ))
            }
            if rule.shortLinkHosts.contains(host) {
                let trimmed = path.hasSuffix("/") ? String(path.dropLast()) : path
                guard (try? rule.shortLinkPath.wholeMatch(in: path)) != nil,
                      let canonicalURL = URL(string: "https://\(host)\(trimmed)")
                else { return .notListing(rule.marketplace) }
                return .listing(ListingURL(marketplace: rule.marketplace, listingId: nil, canonicalURL: canonicalURL))
            }
        }
        return .unsupported
    }
}

/// Not Sendable (Regex is not); the table below is immutable, so sharing it is safe.
private struct Rule {
    let marketplace: ListingMarketplace
    /// Hosts of full listing pages, lower case.
    let hosts: Set<String>
    /// Reads the listing id from the path and returns it with the canonical URL.
    let listing: (String) -> (String, String)?
    /// Hosts of the marketplace's share short links.
    let shortLinkHosts: Set<String>
    let shortLinkPath: Regex<Substring>
}

nonisolated(unsafe) private let shortCode = #/\/[A-Za-z0-9]{4,32}\/?/#

nonisolated(unsafe) private let rules: [Rule] = [
    Rule(
        marketplace: .ebay,
        hosts: ["ebay.com", "www.ebay.com", "m.ebay.com"],
        listing: { path in
            guard let match = try? #/\/itm\/(?:[^\/]+\/)?([0-9]{9,19})\/?/#.wholeMatch(in: path) else { return nil }
            let id = String(match.1)
            return (id, "https://www.ebay.com/itm/\(id)")
        },
        shortLinkHosts: ["ebay.us"],
        shortLinkPath: #/\/(?:m\/)?[A-Za-z0-9]{4,32}\/?/#,
    ),
    Rule(
        marketplace: .poshmark,
        hosts: ["poshmark.com", "www.poshmark.com"],
        listing: { path in
            guard let match = try? #/\/listing\/((?:[^\/]*-)?([0-9A-Fa-f]{24}))\/?/#.wholeMatch(in: path) else {
                return nil
            }
            return (String(match.2).lowercased(), "https://poshmark.com/listing/\(match.1)")
        },
        shortLinkHosts: ["posh.mk"],
        shortLinkPath: shortCode,
    ),
    Rule(
        marketplace: .mercari,
        hosts: ["mercari.com", "www.mercari.com"],
        listing: { path in
            guard let match = try? #/\/(?:us\/)?item\/(m[0-9]{8,14})\/?/#.wholeMatch(in: path) else { return nil }
            let id = String(match.1)
            return (id, "https://www.mercari.com/us/item/\(id)/")
        },
        shortLinkHosts: ["merc.li"],
        shortLinkPath: shortCode,
    ),
    Rule(
        marketplace: .depop,
        hosts: ["depop.com", "www.depop.com"],
        listing: { path in
            guard let match = try? #/\/products\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\/?/#.wholeMatch(in: path),
                  match.1.count <= 200
            else { return nil }
            let id = match.1.lowercased()
            return (id, "https://www.depop.com/products/\(id)/")
        },
        shortLinkHosts: ["depop.app.link"],
        shortLinkPath: shortCode,
    ),
]
