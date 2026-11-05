# Vinted

Vinted is Listora's fifth marketplace. Vinted relaunched in the US in November 2025, and its US
terms cover sellers in the continental United States, Alaska, Hawaii, and Puerto Rico. Vinted
Pro and its Integrations API are offered only in Europe, so Vinted has no API Listora can use.
The captain has Vinted's written permission for Listora's use, browser automation and
commercial reselling on the named account included.

Vinted joins in milestones (the Vinted plan, M1 to M9). Each one ends with its feature hidden,
and a feature turns on only after it passes live on the captain's Vinted test account
([verified-features.md](verified-features.md)). Every write to a real Vinted account first reads
the signed-in member name and stops unless it is the named test account.

## Today: assisted (M1)

Vinted runs on the assisted adapter (`createVintedAdapter` in
`packages/marketplaces/src/assisted/marketplaces.ts`, [marketplaces.md](marketplaces.md)):

- **Listing, price changes, delisting, relisting.** Listora prepares the work as a task: the
  title, description, price, and photos in posting order (up to 20, Vinted's limit), with a link
  to vinted.com. The seller does the step in the Vinted app and confirms it. Only that
  confirmation finishes the step; Listora never says Vinted confirmed it.
- **Sales.** The seller confirms each Vinted sale (`saleDetection: ['manual']`). Listora reads
  no Vinted sale emails yet.
- **Shared listings.** Sharing a Vinted listing to Listora links it. The URL parser
  (`packages/shared/src/listing-url.ts`, and `ListingURL` in the iPhone app) reads
  `vinted.com/items/<id>-<title>`, keeps the numeric id as the listing id, and stores
  `https://www.vinted.com/items/<id>-<title>` in lower case. Vinted's European sites are not
  supported. The fixtures are in `packages/shared/fixtures/listing-urls.json`.
- **Fees and profit.** Vinted charges sellers nothing: buyers pay the Vinted fee and shipping.
  Its fee table (`vinted-us-2025-11-01`, [pricing.md](pricing.md)) has no rules and is marked
  unverified until a real Vinted sale confirms it.
- **The iPhone app** shows Vinted by name, in the marketplace list as an assisted marketplace.

Not yet for Vinted:

- AI-written copy of its own: a Vinted listing starts from the item's own title and description.
- Thrift-scan comparisons (`market_comparison` keeps its own marketplace list, M9).
- Delist-latency and verified-success alarms (`ALARMED_MARKETPLACES` in `infra/src/config.ts`):
  the seller delists Vinted by hand, so they join with its automation.
- Categories and the order and label pages, until Vinted's pages are mapped (M2).

## Milestones still to come

| #   | Milestone                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- |
| M2  | Map Vinted's pages read-only (upload form, item page, listings, sold orders, offers, labels) and write the taxonomy snapshot        |
| M3  | The `vinted` automation profile (`runsOn: 'phone'`, never the cloud), linking on the iPhone, and the session check with member name |
| M4  | Listing import and sales history                                                                                                    |
| M5  | Create, price, hide (delist), and unhide (relist), each read back; "In Vinted's review" is never "Listed"                           |
| M6  | Sale checks and auto-delist, with bundles (one order, several items) and escrow completion                                          |
| M7  | Offers: read, then accept, decline, counter                                                                                         |
| M8  | Shipping labels and pack check (carrier, label or QR code, ship within 5 business days)                                             |
| M9  | Thrift-scan comparisons: asking prices from the public search unless sold results prove readable                                    |

## What differs on Vinted

These shape the later milestones:

- **No delete-and-relist.** Vinted's terms ban it, so Listora never refreshes a Vinted listing,
  and relisting means unhiding a hidden listing. A sold-elsewhere delist hides the listing.
- **Upload review.** Vinted reviews new listings, usually within a minute but sometimes for days.
  A listing in review is not live and cannot be hidden or deleted.
- **A sale is a paid purchase**, not an accepted offer. Offers are not binding.
- **Bundles.** One Vinted order can sell several Listora items; each becomes its own sale.
- **No duplicates.** Vinted bans the same item listed twice, so retries must find an earlier
  attempt before posting again.
- **Bump** is a paid Vinted service. Listora never buys it.
