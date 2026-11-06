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

## Today: assisted (M1), with linking, import, sales history, listing, and offers built

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
- **Thrift-scan comparisons (M9).** The scan card's Vinted row: close matches' asking prices in
  Vinted's public search, read on the iPhone logged out within budgets, cached, and stopped at
  any check; Vinted shows a visitor no sold listings, so the sold side is the household's own
  Vinted sales. Behind `market_comps` on Vinted, off for sellers until the captain's live test
  on the phone ([thrift-scan.md](thrift-scan.md), "Vinted").

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
- **A seller's listing steps stay assisted**, linked or not: the registry serves a linked Vinted
  session with its automation adapter (`createMarketplaceAdapters`), whose listing scripts (M5,
  below) run only in the owner's Test mode until they pass live. The generic fake site
  (`FAKE_AUTOMATION_SITE_URL`) serves Vinted only its session check, never its writing scripts.
  A linked Vinted's offers are read and answered only in Test mode until they pass live (M7,
  below).
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
its listing steps are automated only in Test mode).

Not yet for Vinted:

- AI-written copy of its own: a Vinted listing starts from the item's own title and description.
- Delist-latency and verified-success alarms (`ALARMED_MARKETPLACES` in `infra/src/config.ts`):
  a seller delists Vinted by hand until its listing steps pass live, so they join then.
- Categories (an imported item's), and the order and label pages, until Vinted's pages are
  mapped (M2).

## Create, price, hide, and unhide (M5)

Built, and hidden until their live test: Vinted is in `LISTING_AUTOMATION_NOT_VERIFIED`
(`packages/marketplaces/src/features.ts`), so on a seller's linked Vinted every listing step stays
the assisted task above, and only an account in Test mode gets them automated, on its iPhone
([verified-features.md](verified-features.md), [test-mode.md](test-mode.md)). The executor reads
the account's gate with the listing's connection (`ConnectionRef.listingAutomation`), and the
automation adapter reports those kinds assisted without it (`AutomationAdapter.capabilities`).

| Operation | How (`vinted/scripts.ts`)                                                                                                                       | Confirmed by                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Create    | The upload form (`/items/new`, `pages/upload-form.ts`), then Upload: the only step that changes anything                                        | The item from Vinted's web API     |
| Price     | The listing's own read first (a sold one is refused, one in review waits), then the edit form's price (`/items/<id>/edit`), then Save           | The same                           |
| End       | **Hide** on the listing's page (`pages/item-page.ts`): the listing is kept, with its id and likes. Never a delete                               | The item reads hidden (`ended`)    |
| Relist    | **Unhide** on the listing's page: the same listing again. Vinted's terms ban deleting and relisting the same item, so a relist never posts anew | The item reads for sale (`active`) |
| Read      | The item from Vinted's web API (`/api/v2/items/<id>`), or the newest wardrobe listing with the listing's SKU line when Listora has no id        |                                    |
| Revise    | Not automated: Edit listing stays the seller's in Vinted (`revise` is hidden everywhere)                                                        |                                    |

- **The form, as the script fills it:** up to 20 photos in posting order (each must show on the
  form, or the step stops), title, description with Listora's SKU line (`SKU: AJ-000184`), the
  category picked level by level down to one without subcategories, then the fields the category
  asks for: brand (Vinted's list, matched by name ignoring case and punctuation; Vinted's "No
  brand" when it lists none), size (the item's label, or one that starts with it, `M` is `M / 38
/ 10`), condition, up to two colours, and the package size, then the price (`45`, `12.50`).
- **Package size** sets the buyer's shipping. Vinted's form recommends one for the category,
  which Listora keeps; a `Package size` aspect (small, medium, large) picks another. A category
  with no recommendation and a listing that names none is refused before anything is sent
  (`package_size_required`).
- **Category** (`vinted/categories.ts`): women's, men's, and unisex clothing, shoes, bags,
  accessories, and jewellery map to a category of Vinted's Women and Men trees, every target one
  the upload form offered the test account (its category list, read 2026-11-05 by M2). Vinted
  files jackets and coats by their kind, which the item's title or name picks (denim, bomber,
  puffer, trench, ...). Kids', home, and other items, shoes of no kind, and a jacket that names
  none ask the seller for a category (`variant.categoryRef`, Vinted's names joined with `>`).
  The map is checked against M2's taxonomy snapshot once it lands.
- **Conditions** (`payload.ts`): new with tags is "New with tags", new without tags "New without
  tags", pre-owned excellent "Very good", pre-owned good and new with defects "Good", pre-owned
  fair "Satisfactory".
- **Sizes** are Vinted's per category, read on the form: a size the category's list doesn't have
  is refused before anything is sent (`size_not_offered`, naming a few of its sizes). M2's
  taxonomy moves this check into validation.
- **Limits** (`VINTED_LIMITS`, modeled until M2 reads the form): titles of 3 to 100 characters,
  descriptions up to 2,000 characters with the SKU line (1,929 of the seller's), prices from $1 to
  $5,000, 20 photos.
- **No duplicates.** Vinted bans the same item listed twice. A create whose earlier attempt may
  have posted (`mayHaveApplied`) first reads the newest wardrobe listings for its SKU line and
  posts nothing when it finds it; an Upload whose page doesn't name the new listing finds it the
  same way.
- **Vinted's review.** Vinted reviews every new upload, usually for a minute, sometimes for days.
  A listing under review reads as not live yet (`inReview`, never "gone"), so the create stays
  `verifying` with "In Vinted's review" and is never sent again; it succeeds once a read shows it
  for sale ([operations.md](operations.md)). Vinted won't hide or delete a listing it is
  reviewing, so an end reads the listing first and waits (`not_yet`, code `in_review`, "Delisting...
  after Vinted's review"), tried again after a minute at the soonest; a price change waits the
  same way. Read from the web API's item (`is_processing`, or `is_visible` false while not
  hidden): modeled until the mapping reads an item under review.
- **Checks.** Vinted's account verification before listing (`/users/verification`, which M2
  met on the test account when it picked a category) stops the run like every other check, and
  the step becomes the seller's task.
- **Modeled pages.** Only the upload page's path and title and its category field and list were
  read (M2); the other fields' selectors, the item page's Hide and Unhide, the edit form, and the
  item's review fields are Listora's model until the mapping reads them. A page that differs
  stops the step before anything is sent (or, after Upload, leaves it to the read-back), and its
  fix is one page module.
- **The phone** needs no new app build: the server hands the app the runtime with the Vinted
  scripts (`npm run phone:bundle` rebuilds the committed copy).

**The live test** is the captain's, in Test mode, on toniojx only (the scripts first read the
signed-in member and change nothing for another), once Vinted's seller verification of the
account is done: list a test item, change its price, end it (Hide), relist it (Unhide), end it
again, then delete it in Vinted. It removes Vinted from `LISTING_AUTOMATION_NOT_VERIFIED` in the
change that records it, with the run in the listing actions table of
[verified-features.md](verified-features.md).

Tests: `vinted/adapter.conformance.int.test.ts` and `phone/conformance-vinted.int.test.ts` (the
shared conformance suite in Chromium and through the phone runtime: create, price, end, relist,
read-backs, absences, error mapping, health), `vinted/listing.int.test.ts` (every field, 20
photos, the mapped category, No brand, the package size kept and picked and missing, a size the
form lacks, a category without sizes, Vinted's refusal, no second upload, the review's reads and
waits, a sold listing, Vinted's account verification, a changed form, a Hide that may have gone
through, and the Test-mode gate), `vinted/payload.test.ts`, `vinted/categories.test.ts`,
`operations/src/executor.int.test.ts` (a create and a price change in review are never sent
again, and the gate reaches the adapter), and `operations/src/status-display.test.ts`.

## Offers (M7)

Built, and hidden until their live test: `offers` and `offer_answers` are not on Vinted's list in
`features.ts`, so a seller's Vinted offers are never read, and only an account in Test mode reads
and answers them, on its iPhone ([offers.md](offers.md), [test-mode.md](test-mode.md)). The flow
is every marketplace's (a read into Tasks, an answer only for the seller's confirmed tap, sent
once, done only by read-back); what differs on Vinted is in `vinted/pages/offers.ts` and
`OFFER_RULES.vinted`:

- **Offers live in conversations.** A buyer asks for a price in the conversation about the item,
  and the seller answers there. The read opens the seller's settings, reads the member signed in
  (`/api/v2/users/current`), then their 20 newest conversations (`/api/v2/inbox`), then each
  one's record (`/api/v2/conversations/<id>`), a step each: its `transaction` (the item, or a
  bundle's items, and the `seller_id` and `buyer_id`), the buyer's public `login`, and its
  messages. The newest offer message decides: the buyer's (`offer_request_message`), pending,
  waits on the seller; the seller's (`offer_message`), pending, is their counteroffer and waits on
  the buyer; accepted is accepted; the buyer's declined is declined; expired, canceled, or the
  seller's counteroffer the buyer declined is over. A conversation about an item the member
  bought, or about no sale, holds none of the seller's offers. A status or author Listora
  doesn't know stops the read rather than guess. Listora's id of a Vinted offer is
  `<conversation id>/<transaction id>`; its Open in Vinted is the conversation. A bundle's offer
  names no one listing and covers its items (`listingCount`).
- **Not binding.** Accepting lets the buyer buy at that price; the item sells only once they pay
  (`accept: 'buyer_checkout'`, the offer's note says so), so the sale comes through the sale
  checks from Vinted's sold orders, never from the accept. Vinted shows no offer expiry Listora
  has read, so none is shown.
- **The 40% floor.** Vinted's buyers offer at most 40% below the price, and a counteroffer is an
  offer too: `floorPercent: 60` makes `requestOfferAnswer` refuse a counter below 60% of the
  listing's price (rounded up to the cent) before anything reaches the phone, and the offer's
  `counterRange` starts a cent under that floor, so the app's own check matches. It binds only
  when the price rose after the offer; otherwise a counter above the offer is above it already.
- **Conversation-scoped answers only.** An answer opens the offer's own conversation
  (`/inbox/<id>`), reads it from the web API (an offer that moved or is over sends nothing), and
  uses only the offer card's Accept, Decline, or Counter offer and its confirmation (a counter's
  price goes in the offer dialog's price field). Only that confirmation changes anything.
  Listora never types in the conversation's message box, sends no message of its own, and never
  writes to any other member: the plan leaves out offers to likers and any outreach (Vinted's
  terms ban mass messages, and its robots.txt bans automation that simulates a customer
  interaction). Like every write,
  the answer first reads the member signed in and changes nothing unless it is the linked one.
- **Checks.** DataDome (on a page or an API answer) and Vinted's sign-in steps stop the read or
  the answer for the seller; an offer card the page doesn't draw hands the answer to the seller in
  Vinted (`element_missing`).
- **Modeled pages.** The inbox and conversation reads, their fields, and the conversation page's
  offer card (`CONVERSATION_PAGE`) are Listora's model until the read-only mapping (M2) records a
  conversation with an offer; a page or record that differs stops the step, and its fix is
  `pages/offers.ts`. A read looks at the 20 newest conversations only: an offer in an older
  conversation is not read (and one Listora had there closes) until the mapping shows whether the
  inbox names the conversations with offers.
- **The phone** needs no new app build: the server hands the app the runtime with the offer
  scripts (`npm run phone:bundle`), and offers already run on runtime version 3.

**The live test** is the captain's, in Test mode, on toniojx only, once Vinted's seller
verification of the account is done: a second account makes offers on a toniojx test listing;
Tasks shows the offer (read), then decline one, counter one (above the floor), and accept one,
each confirmed by Listora's read-back; the test listing is deleted in Vinted afterward. It adds
`offers` and `offer_answers` to Vinted's list in `features.ts` in the change that records it.

Tests: `vinted/offers.int.test.ts` (the shared offers suite on the fake Vinted's conversations,
then a conversation about a purchase or no sale, an offer waiting on the buyer, a bundle, an
unknown status, Vinted's refusal of a counter below its floor, a session signed in as another
member, a read-back of a gone or replaced offer, only GETs besides the answer, and no message
sent after any test), `phone/health-vinted.int.test.ts` (a read and a counter through the phone
runtime), `vinted/pages/offers.test.ts` (the statuses, the floor, hidden for sellers), and
`apps/api/src/offers/offers.int.test.ts` (the non-binding note, the counter range, and the
floor's refusal).

## Milestones still to come

M3's live link, M4's live import, M5's live listing, and M7's live offers on the test account on
the iPhone are still to run (above).

| #   | Milestone                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------- |
| M2  | Map Vinted's pages read-only (upload form, item page, listings, sold orders, offers, labels) and write the taxonomy snapshot |
| M6  | Sale checks and auto-delist, with bundles (one order, several items) and escrow completion                                   |
| M8  | Shipping labels and pack check (carrier, label or QR code, ship within 5 business days)                                      |

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
