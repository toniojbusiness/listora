import Core
import Foundation
import Testing

/// The fixture file the server's parser is tested against too
/// (`packages/shared/fixtures/listing-urls.json`), read from the checkout: simulator tests can
/// read the Mac's file system, so both parsers always see the same cases.
private struct ListingURLFixtures: Decodable {
    struct Listing: Decodable, Sendable, CustomTestStringConvertible {
        let note: String
        let url: String
        let marketplace: String
        let listingId: String?
        let canonicalUrl: String
        var testDescription: String {
            note
        }
    }

    struct Page: Decodable, Sendable, CustomTestStringConvertible {
        let note: String
        let url: String
        let marketplace: String?
        var testDescription: String {
            note
        }
    }

    let listings: [Listing]
    let notListings: [Page]
    let unsupported: [Page]

    static let file = URL(filePath: #filePath)
        .deletingLastPathComponent() // CoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // Core
        .deletingLastPathComponent() // Packages
        .deletingLastPathComponent() // ios
        .deletingLastPathComponent() // apps
        .deletingLastPathComponent() // repository root
        .appending(path: "packages/shared/fixtures/listing-urls.json")

    static let shared: ListingURLFixtures = {
        guard let data = try? Data(contentsOf: file),
              let fixtures = try? JSONDecoder().decode(ListingURLFixtures.self, from: data)
        else { return ListingURLFixtures(listings: [], notListings: [], unsupported: []) }
        return fixtures
    }()
}

struct ListingURLTests {
    @Test
    func `reads the shared fixtures, covering full and short links on every marketplace`() {
        let fixtures = ListingURLFixtures.shared
        #expect(!fixtures.listings.isEmpty, "could not read \(ListingURLFixtures.file.path)")
        for marketplace in ListingMarketplace.allCases {
            let cases = fixtures.listings.filter { $0.marketplace == marketplace.rawValue }
            #expect(cases.contains { $0.listingId != nil }, "no full listing URL for \(marketplace)")
            #expect(cases.contains { $0.listingId == nil }, "no short link for \(marketplace)")
        }
        #expect(!fixtures.notListings.isEmpty)
        #expect(!fixtures.unsupported.isEmpty)
    }

    @Test(arguments: ListingURLFixtures.shared.listings)
    private func `reads the marketplace, listing id, and canonical URL`(fixture: ListingURLFixtures.Listing) throws {
        let marketplace = try #require(ListingMarketplace(rawValue: fixture.marketplace))
        let canonical = try #require(URL(string: fixture.canonicalUrl))
        let expected = ListingURLParse.listing(ListingURL(
            marketplace: marketplace,
            listingId: fixture.listingId,
            canonicalURL: canonical,
        ))
        #expect(ListingURLParse(fixture.url) == expected)
        // The canonical form parses to itself.
        #expect(ListingURLParse(canonical) == expected)
    }

    @Test(arguments: ListingURLFixtures.shared.notListings)
    private func `knows a marketplace page that is not a listing`(fixture: ListingURLFixtures.Page) throws {
        let marketplace = try #require(fixture.marketplace.flatMap(ListingMarketplace.init(rawValue:)))
        #expect(ListingURLParse(fixture.url) == .notListing(marketplace))
    }

    @Test(arguments: ListingURLFixtures.shared.unsupported)
    private func `rejects a URL that is not a supported marketplace`(fixture: ListingURLFixtures.Page) {
        #expect(ListingURLParse(fixture.url) == .unsupported)
    }

    @Test
    func `accepts an explicit default port like the server does`() {
        guard case let .listing(listing) = ListingURLParse("https://www.ebay.com:443/itm/266512345678") else {
            Issue.record("expected a listing")
            return
        }
        #expect(listing.canonicalURL.absoluteString == "https://www.ebay.com/itm/266512345678")
        #expect(!listing.isShortLink)
    }
}
