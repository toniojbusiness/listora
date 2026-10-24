import Core
import Foundation
import Testing

struct SharedContentTests {
    private let listingURL =
        URL(string: "https://poshmark.com/listing/Lululemon-Align-Pant-25-64f1a2b3c4d5e6f7a8b9c0d1")

    @Test
    func `uses the shared URL from Safari`() throws {
        let content = try SharedContent(urls: [#require(listingURL)], title: "Lululemon Align Pant 25 | Poshmark")
        guard case let .listing(listing) = content.listingParse else {
            Issue.record("expected a listing, got \(content.listingParse)")
            return
        }
        #expect(listing.marketplace == .poshmark)
        #expect(listing.listingId == "64f1a2b3c4d5e6f7a8b9c0d1")
        // The page title without the marketplace's name.
        #expect(content.suggestedTitle == "Lululemon Align Pant 25")
    }

    @Test
    func `finds the link in text a marketplace app shared`() throws {
        let content = SharedContent(text: "Check out this listing I found on Poshmark: https://posh.mk/aBc12XyZ")
        #expect(try content.listingParse == .listing(ListingURL(
            marketplace: .poshmark,
            listingId: nil,
            canonicalURL: #require(URL(
                string: "https://posh.mk/aBc12XyZ",
            )),
        )))
        #expect(content.suggestedTitle == "Check out this listing I found on Poshmark")
    }

    @Test
    func `prefers a listing over another marketplace page or another site`() throws {
        let content = try SharedContent(
            urls: [
                #require(URL(string: "https://example.com/article")),
                #require(URL(string: "https://poshmark.com/closet/janedoe")),
            ],
            text: "also https://www.mercari.com/us/item/m12345678901/",
        )
        guard case let .listing(listing) = content.listingParse else {
            Issue.record("expected a listing")
            return
        }
        #expect(listing.marketplace == .mercari)
    }

    @Test
    func `says which marketplace page was shared when it is not a listing`() throws {
        let content = try SharedContent(urls: [#require(URL(string: "https://poshmark.com/closet/janedoe"))])
        #expect(content.listingParse == .notListing(.poshmark))
        #expect(SharedContent(text: "just some words").listingParse == .unsupported)
        #expect(SharedContent().listingParse == .unsupported)
    }

    @Test
    func `suggests no title when only a link was shared, and caps a long one`() {
        #expect(SharedContent(text: "https://posh.mk/aBc12XyZ").suggestedTitle == nil)
        #expect(SharedContent(text: "  \n ").suggestedTitle == nil)
        let long = String(repeating: "a", count: 300)
        #expect(SharedContent(title: long).suggestedTitle?.count == SharedContent.maxTitleLength)
        #expect(SharedContent(title: "Nike Air Max 90 (Size 10) | eBay").suggestedTitle == "Nike Air Max 90 (Size 10)")
    }
}
