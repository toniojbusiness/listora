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

## Today: assisted (M1), with linking (M3) and import and sales history (M4) built

Vinted runs on the assisted adapter (`createVintedAdapter` in
`packages/marketplaces/src/assisted/marketplaces.ts`, [marketplaces.md](marketplaces.md)):

- **Listing, price changes, delisting, relisting.** Listora prepares the work as a task: the
  title, description, price, and photos in posting order (up to 20, Vinted's limit), with a link
  to vinted.com. The seller does the step in the Vinted app and confirms it. Only that
  confirmation finishes the step; Listora never says Vinted confirmed it.
- **Sales.** The seller confirms each Vinted sale (`saleDetection: ['manual']`). Listora reads
  no Vinted sale emails yet. A linked Vinted's sold orders are read too (M4, below), behind
  features that are still hidden.
- **Shared listings.** Sharing a Vinted listing to Listora links it. The URL parser
  (`packages/shared/src/listing-url.ts`, and `ListingURL` in the iPhone app) reads
  `vinted.com/items/<id>-<title>`, keeps the numeric id as the listing id, and stores
  `https://www.vinted.com/items/<id>-<title>` in lower case. Vinted's European sites are not
  supported. The fixtures are in `packages/shared/fixtures/listing-urls.json`.
- **Fees and profit.** Vinted charges sellers nothing: buyers pay the Vinted fee and shipping.
  Its fee table (`vinted-us-2025-11-01`, [pricing.md](pricing.md)) has no rules and is marked
  unverified until a real Vinted sale confirms it.
- **The iPhone app** shows Vinted by name, in the marketplace list as an assisted marketplace.

## Linking and the session check (M3)

Vinted is linked by signing in, like Poshmark, Mercari, and Depop
([marketplace-linking.md](marketplace-linking.md)), and runs on the seller's iPhone only
([phone-execution.md](phone-execution.md)):

- **The profile** (`vinted` in `packages/automation/src/profiles.ts`, its parts in
  `packages/automation/src/vinted/site.ts`): `runsOn: 'phone'` and `cloudAllowed: false`, so the
  app offers no cloud and the API refuses a move there. Vinted uses automated enforcement (its
  terms, section 7), so the seller's own iPhone, session, and network is the only place it runs.
  Origins `https://www.vinted.com` and `https://vinted.com`, cookies on `vinted.com`, and its web
  API on its own origin (`https://www.vinted.com/api/v2/`), which its pages read signed in by the
  session's cookies alone (`apiGet`'s `pageCookies`).
- **Pace.** 0.45 to 1.1 s before every action and 5 to 20 s between sessions (read-only
  connections 0.6 to 1.5 s), and 15 runs an hour and 100 a day: half the other marketplaces',
  while Vinted has no live run behind it. `AUTOMATION_VINTED_*` changes them within the floor and
  ceiling ([automation.md](automation.md)).
- **Checks.** Vinted's sign-up and sign-in chooser (`/member/signup/...`, `/member/login`), its
  code and ID-check steps, and DataDome (its challenge frames on `captcha-delivery.com`, already
  a generic sign, and its `#ddChallengeContainer`) stop the run, and the app hands the check to
  the seller. Listora never solves, skips, or hides one.
- **Private parts.** Screenshots black out addresses, conversations, messages, and the member's
  own details (`VINTED_PRIVATE_SELECTORS`), on top of every form field.
- **Linking.** Link accounts opens Vinted's sign-in chooser
  (`https://www.vinted.com/member/signup/select_type`) in the app; the seller signs in there,
  and the app hands over the cookies on `vinted.com`.
- **The session check** (`createVintedAutomationAdapter`, `vinted/scripts.ts`, the bundled phone
  runtime) opens the seller's profile settings (`/settings/profile`), waits for the header's user
  menu (`user-menu-button`, which only a member's pages draw), and asks Vinted's web API which
  member is signed in (`GET /api/v2/users/current`): their `login`, lower-cased, is the
  connection's seller (`external_user_id`). An answer without a login leaves the seller unknown,
  never a guess. A settings page without the menu, or an answer Listora doesn't know, is
  `Not confirmed` ("couldn't read Vinted"), and the session is kept. Read on the test account
  (2026-11-05): the menu's own profile link is `/member/<id>`, with no login, and is drawn only
  once the menu is opened, so M3's first model of it (a header link with the login) was wrong.
- **Every listing step stays assisted**, linked or not: the registry serves a linked Vinted
  session with its automation adapter (`createMarketplaceAdapters`), which only reads, and a kind
  of step without a script stays the assisted adapter's. The generic fake site
  (`FAKE_AUTOMATION_SITE_URL`) serves Vinted only its session check, never its writing scripts.
  A linked Vinted gets no offer read: offers are not built (M7).
- **Hidden until its live link.** Linking is not on the feature list yet, so Vinted is in
  `LINKING_NOT_VERIFIED` (`packages/marketplaces/src/features.ts`): Link accounts lists it only in
  the owner's Test mode ([test-mode.md](test-mode.md)) or once the account linked it (so a linked
  account can still be checked, relinked, and unlinked), and `getMarketplaceSession` and
  `linkMarketplaceSession` answer `404` otherwise. The live test is the captain's link of the
  Vinted test account on the iPhone, in Test mode; it removes Vinted from that list in the
  change that records it.
- **Modeled pages.** The settings page's user menu and the web API's member, wardrobe, and sold
  orders were read on the test account (2026-11-05); the other paths and selectors
  (`vinted/site.ts`, `vinted/pages/`) are still Listora's model: the read-only mapping (M2,
  `recordings/`) and the first linked session confirm them, and a page that differs is one page
  module to fix. The fake Vinted site (`vinted/fake/`, `npm run dev:fake-vinted-site`,
  `FAKE_VINTED_SITE_URL`) serves those pages and the web API, with Vinted's checks as faults.
- **The phone** needs no new app build: the server hands the app the runtime with the Vinted
  scripts, and the check's origins, API origins, and cookie domains come from the server. The app's own build
  only adds Vinted to the web views it keeps warm while open (`WebPhoneRuntime`), so a build
  without it starts Vinted's first call a moment slower.

Tests: `vinted/adapter.int.test.ts` (the check on the fake site in Chromium: the member read, an
unknown member, a changed page, DataDome, a CAPTCHA, a sign-in code, a signed-out session, a rate
limit, an error page, and every listing step assisted), `phone/health-vinted.int.test.ts` (the
same check through the phone runtime), `vinted/site.test.ts` (member paths, the profile, its
checks), and `marketplace-sessions.int.test.ts` (hidden from a seller, linked in Test mode on the
phone, and still listed once linked).

## Listing import and sales history (M4)

Built, and hidden until their live test (`listing_import`, `sales_history`, and `sale_checks`
stay off the list in `features.ts`; the owner's Test mode shows them). Both read Vinted's web
API from the seller's settings page, on their iPhone, with GETs only
(`vinted/pages/api.ts`):

- **Listings** (`listings`, [imports.md](imports.md)): the member from
  `/api/v2/users/current`, then their wardrobe (`/api/v2/wardrobe/<id>/items`, 96 a page, newest
  first, `pagination.total_pages`), then each listing for sale's own item read
  (`/api/v2/items/<id>`) for its description, category id, and colours. A listing Listora has
  is taken from the wardrobe's record alone (`fromList`). Hidden listings, drafts, and sold ones
  are not for sale; one reserved for a buyer is. The details (`pages/listing-details.ts`): the
  photos' `full_size_url`s, `brand_title` ("No brand" is none), `size_title`, the condition
  ("New with tags", "New without tags", "Very good" is pre-owned excellent, "Good",
  "Satisfactory" is pre-owned fair; or its id), and `color1` and `color2` in Listora's colours.
  The category is Vinted's `catalog_id`, which Listora can't place until the taxonomy snapshot
  (M2), so an imported item has no category yet.
- **Sold orders** (`orders`, [sales.md](sales.md#sales-history)): the member's sold orders in
  progress and completed (`/api/v2/my_orders?type=sold&status=...`, 20 a page, newest first),
  never canceled ones, each with the items that sold in it (`/api/v2/transactions/<id>`). A
  bundle is one order with several items, each at its own price; a single item takes the
  order's price. A completed order is shipped (delivered, and confirmed or two days passed).
  The sales history reads at most 10 pages and 150 orders' items per state; a later check
  reads 2 pages and 20, back to the last check. Escrow completion, a cancel after payment, and
  the delists elsewhere that a new sale starts are M6's: `sale_checks` stays hidden until then.
- **Checks.** DataDome's answer to an API call it blocks (403, JSON naming
  `captcha-delivery.com`) stops the run as a CAPTCHA, and Vinted's "Member verification
  required" (400, `user_verification_required`, `apiVerificationCodes` in the profile) as a
  sign-in check for the seller to complete in Vinted. Listora never passes either.

**Read on the test account** (toniojx, 2026-11-05, read-only, the market Chrome on the Mac, one
read every 30 s through `market-pace.sh vinted`): the signed-in member (`users/current`, its
`id` and `login`, read before anything else), and an empty wardrobe in the modeled shape
(`items`, `pagination`). The sold orders answered "Member verification required" until the
account adds a phone number (Vinted's settings show "Action needed"). The item and transaction
reads are still modeled. Listora's own scripts, run through the phone runtime against that Chrome,
stopped at a bot check on the settings page and handed it to the seller, as they must; a check
from a desktop browser driven over CDP says nothing of the iPhone.

**The live test** is the captain's, on the iPhone in Test mode, on toniojx only: link Vinted
(which starts the import and the first sale check), then Import your listings. It needs a listing
on the account, and the account's verification done, for the import and the history to read
anything. It removes `listing_import` and `sales_history` from hidden in the change that records
it.

Tests: `vinted/adapter.int.test.ts` (listings with their details, pages, the listings Listora
has, the member's own wardrobe; orders in progress and completed, a bundle, a canceled order left
out, `since`, the history's pages; DataDome, verification required, a rate limit, an answer
Listora doesn't know, a signed-out answer), `phone/health-vinted.int.test.ts` (both reads through
the phone runtime), `vinted/pages/listing-details.test.ts`, `imports/src/start.test.ts` (hidden
from a seller, on in Test mode), and `automation/src/adapters.test.ts` (a linked Vinted reads, and
every listing step stays assisted).

Not yet for Vinted:

- AI-written copy of its own: a Vinted listing starts from the item's own title and description.
- Thrift-scan comparisons (`market_comparison` keeps its own marketplace list, M9).
- Delist-latency and verified-success alarms (`ALARMED_MARKETPLACES` in `infra/src/config.ts`):
  the seller delists Vinted by hand, so they join with its automation.
- Categories (an imported item's), and the order and label pages, until Vinted's pages are
  mapped (M2).

## Milestones still to come

M3's live link and M4's live import of the test account on the iPhone are still to run (above).

| #   | Milestone                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------- |
| M2  | Map Vinted's pages read-only (upload form, item page, listings, sold orders, offers, labels) and write the taxonomy snapshot |
| M5  | Create, price, hide (delist), and unhide (relist), each read back; "In Vinted's review" is never "Listed"                    |
| M6  | Sale checks and auto-delist, with bundles (one order, several items) and escrow completion                                   |
| M7  | Offers: read, then accept, decline, counter                                                                                  |
| M8  | Shipping labels and pack check (carrier, label or QR code, ship within 5 business days)                                      |
| M9  | Thrift-scan comparisons: asking prices from the public search unless sold results prove readable                             |

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
