# eBay automation

Listora's eBay API adapter ([ebay.md](ebay.md)) needs Listora's eBay developer keys, which do not
exist yet. eBay permitted the product owner to automate their own account (decision D1, revised
2026-10-24). So until the keys exist, Listora acts on eBay through the seller's own browser
session, in the cloud browser runner ([automation.md](automation.md)). The code is in
`packages/automation/src/ebay/`. The runner's safety rules apply to every step:

- Every action is human-paced. Each seller's account gets a limited number of runs.
- The first CAPTCHA, security check, sign-in page, or sign-in code step stops the run. Listora
  never tries to get past one. The step becomes the user's assisted task, and the connection
  waits until the seller signs in again in the app.
- Passwords are never stored, only the session cookies, encrypted.
- Every change is confirmed by a read-back of the listing's page.

The seller links eBay like the other marketplaces: **Settings > Link accounts**, where eBay's own
sign-in page opens in the app ([marketplace-linking.md](marketplace-linking.md)).

## The API comes first

A seller has one eBay connection, and its mode decides which adapter serves it
(`ConnectionAwareAdapter`, [marketplaces.md](marketplaces.md#adapter-model)):

- An `api` connection always gets the eBay API adapter, whatever its status (or the assisted
  adapter while no API adapter is configured). An eBay API connection that needs reconnecting is
  never automated in the meantime.
- An `automation` connection with a working session (`connected` or `degraded`) gets this
  adapter. Without a session, it gets the assisted adapter.
- A listing without a connection gets the API adapter when one is configured, which asks the
  seller to connect eBay, as before automation. Without the API's keys it is assisted: the user
  lists it on eBay, until they link a session.
- Linking a browser session to an account whose eBay connection uses the API is refused
  (`409 marketplace_action_unavailable`, "eBay is connected through its API").
- An account has at most one connection per marketplace, and eBay's connect flow
  (`completeAuthorization`, [connections.md](connections.md)) stores the grant on the account's
  existing connection with the mode `api`. So once the keys exist and the seller connects eBay,
  the automation connection becomes an `api` one: the API takes over at once, its sale checks
  stop (they run only for automation connections), and eBay's order poll starts
  ([ebay-notifications.md](ebay-notifications.md)).

**No data migration.** Both modes address the same listings the same way:

- by eBay's item number (`ItemID`), the listing's `external_listing_id`, which the Trading API
  reads, revises, and ends;
- by the seller's SKU, which this adapter types into the form's **Custom label (SKU)** field,
  exactly the SKU the API adapter sends (`externalSku`, else the listing id), so the API finds an
  automated listing by SKU too;
- with the same content: the category, condition id, item specifics, and description HTML come
  from the API adapter's builder (`buildEbayPayload`), so a listing automated today is the listing
  the API would have made;
- with the same orders: a sale check names an order by eBay's order number (`12-34567-89012`), as
  the Fulfillment API does, so a sale is never recorded twice across a switch.

## What it does

| Operation  | How                                                                                                                       | Confirmed by                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Create     | Fills the listing form in the listing's category (`/lstng?mode=AddItem&categoryId=<id>`), then List it                    | The listing's page: status, title, price, and text |
| Revise     | Fills the revise form (`/lstng?mode=ReviseItem&itemId=<id>`) with every detail except photos, then Revise it              | The same                                           |
| Price      | Fills only the price on the revise form, then Revise it                                                                   | The same                                           |
| End        | Seller Hub's end page (`/sh/lst/end?itemId=<id>`), reason "The item is no longer available"                               | The listing's page shows it ended (`ended`)        |
| Relist     | eBay's relist form (`/lstng?mode=RelistItem&itemId=<id>`), filled with the listing's content, lists it under a new number | The new listing's page shows it on sale (`active`) |
| Mark sold  | Not needed: eBay marks its own sales sold                                                                                 |                                                    |
| Read       | The listing's page (`/itm/<id>`), and its revise form for the description of a listing on sale                            |                                                    |
| Sale check | Seller Hub's sold listings (`/sh/lst/sold`), newest first, up to 5 pages                                                  |                                                    |
| Listings   | Seller Hub's active listings (`/sh/lst/active`), up to 25 pages (`listListings`, for imports and drift checks)            |                                                    |
| Health     | Seller Hub's overview (`/sh/ovw`)                                                                                         |                                                    |

Only the click that submits a change (List it, Revise it, End listing) can change anything;
every step before it only fills in or reads.

- **Ending keeps the listing.** eBay keeps an ended listing's page, which reads as `ended`, so the
  read-back confirms the end. A listing that already sold or ended is not touched.
- **A relist is a new item number**, as with the Trading API's relist. The relisted listing keeps
  the photos it had; its other details are the listing's content. A listing still on sale is left
  as it is.
- A revise fills in every item specific the listing's content has; one the content no longer
  has stays as it was on eBay.
- A sold or ended listing cannot be revised. Listora refuses those steps and tells the user to
  relist the item.
- `listListings` reports each active listing's item number, title, and price. Seller Hub's rows
  show no description or last update, so they are never read-backs. It reports
  `complete: false` when the page limit is reached.
- A sale check reports one order per order number, with a line for each of the seller's
  listings in it.

**Reads.** The listing's page shows its status, title, price, and item number. eBay shows the
description in a frame from its description server, so the scripts read it from the listing's
revise form instead (only opened, never typed into or submitted): the editor's HTML view holds
exactly the HTML the form was given, which the API adapter's `descriptionText` turns back into
Listora's text. A listing that sold or ended has no revise form; its description reads as `null`,
which no read-back of an end compares.

**Freshness.** The listing's revision is the newest time its page shows, in milliseconds: when it
was last updated ("Last updated on Oct 25, 2026 09:12:45 PDT"), ended, or sold; `0` for a listing
never changed since it was listed. eBay shows these times to the second, in US time zones
(`ebayTimeIn` reads PST, PDT, and the other US zones). Every Listora change is its own browser
session, at least two seconds after the last (`PACING_FLOOR.sessionGapMs`), so each one gets a
newer revision, and an item number never comes back on sale, so its times only grow. A stale page
shows an older time, and the engine ignores it ([operations.md](operations.md)). The API adapter
declares `readFreshness: 'none'`, because the Trading API's reads carry no such marker; this
adapter declares `revision`.

**Absence.** Never definitive. eBay's "We looked everywhere" page could be a listing not visible
yet, and eBay drops old ended listings' pages after a while.

**Finding a listing again.** A create whose answer was lost, and every later attempt of a create
or relist, first looks for the listing's SKU in the Custom label column of the newest 8 active
listings, and reports that listing instead of listing a second one.

## Mapping Listora's details to eBay's

The mappings are static tables in the repository, shared with the API adapter so both modes list
the same way. Each has tests (`mapping.test.ts` here, and the API adapter's own).

- **Category**: the API adapter's map (`packages/marketplaces/src/ebay/categories.ts`): the
  canonical category and the department (men or women) to an eBay US leaf category, for example
  `clothing/outerwear/denim_jackets` for men becomes 57988 (Coats, Jackets & Vests). The most
  specific entry wins. The variant's own `categoryRef` (an eBay category id) wins over the map.
  Kids', unisex, home, and other items have no mapping; validation then asks for a category. The
  form opens in that category, and the script checks it shows that one.
- **Condition** (`conditions.ts`): the API adapter's condition ids (eBay's condition id list),
  which the form's condition options carry as their values. What the form calls them depends on
  the category:

  | Listora             | Clothing (apparel)         | Shoes                 | Accessories and bags  |
  | ------------------- | -------------------------- | --------------------- | --------------------- |
  | new_with_tags       | 1000 New with tags         | 1000 New with box     | 1000 New with tags    |
  | new_without_tags    | 1500 New without tags      | 1500 New without box  | 1500 New without tags |
  | new_with_defects    | 1750 New with defects      | 1750 New with defects | 1750 New with defects |
  | pre_owned_excellent | 2990 Pre-owned - Excellent | 3000 Pre-owned        | 3000 Pre-owned        |
  | pre_owned_good      | 3000 Pre-owned - Good      | 3000 Pre-owned        | 3000 Pre-owned        |
  | pre_owned_fair      | 3010 Pre-owned - Fair      | 3000 Pre-owned        | 3000 Pre-owned        |

  The condition notes and flaws go into the condition description.

- **Size**: the API adapter's standard sizes (`packages/marketplaces/src/ebay/sizes.ts`), which eBay
  requires since August 2026: `Small` becomes `S`, `2XL` becomes `XXL`, numeric and waist sizes
  with a Size Type and Inseam, and US shoe sizes in halves (`10 1/2` becomes `10.5`, in US Shoe
  Size). UK and EU shoe sizes are not mapped. Clothing and shoes need a size that maps; validation
  asks for one otherwise.
- **Item specifics**: Brand (`Unbranded` without one), Department, the size, Color, Material,
  Pattern, and MPN from the item, then the variant's own aspects, which win by name
  (`buildEbayPayload`). Each goes into the category's field of that name; one the category has no
  field for is added with **Add item specific**. Several values are separated by commas.
- **Description**: the API adapter's HTML (`descriptionHtml`: the text escaped, line breaks as
  `<br>`), typed into the editor's HTML view.
- **Shipping, payment, and returns**: left as the seller set them up on eBay. The form starts with
  the seller's own business policies. A seller who has set none up gets eBay's own message asking
  for them, which Listora shows as a rejection the user can fix.
- **Limits** (`payload.ts`, from the API adapter's `EBAY_LIMITS` and validation):
  - title: at most 80 characters, no HTML
  - prices: at least $0.99 for a fixed-price listing, in dollars and cents
  - photos: 1 to 24, uploaded in posting order (the first is the cover)
  - item specifics: eBay's counts and lengths

## Structure

```text
ebay/
  adapter.ts       the scripts, on the AutomationAdapter base
  site.ts          eBay's origin, paths, item numbers, its challenge signs and private page parts
  payload.ts       the payload (from the API adapter's builder) and validation
  conditions.ts    the form's condition names by kind of category
  pages/           one module per page, with that page's selectors:
                   overview-page, listing-form (new, revise, and relist), item-page, end-page,
                   active-listings-page, sold-listings-page; common has prices and times
  fake/            the fake eBay site, its conformance driver, its CLI
```

A page module throws `PageChangedError` when its page is not as it expects. The error message
names the page and what is missing, for example "eBay's listing form has no title field
(input[name="title"]); the page may have changed.". The run records it as `element_missing`:

- If it happens before anything was sent, the step falls back to the user's task.
- If it happens after the change was sent, the outcome is unknown, and a read-back decides.
- In a read, the read fails and is retried.

So a change to eBay's site costs at most an assisted task. Fixing it means changing one page
module's selectors.

**eBay's own checks** (`site.ts`, on top of the runner's generic ones): its security check page
(`/splashui/challenge` and `/splashui/captcha`, "Please verify yourself to continue") and "Pardon
Our Interruption" are bot checks; its sign-in pages (on `signin.ebay.com`, which is one of the
profile's origins so a rejected session is stopped as a login page) are a rejected session; a
code, passkey, or "verify it's you" step is a login challenge. Failure screenshots black out the
buyer, the shipping address, messages, and the seller's user id.

## Local development and tests

The tests never send traffic to eBay. They run in a real headless Chromium against the fake eBay
site (`fake/fake-ebay-site.ts`). The fake copies the adapter's model of eBay: the same paths and
form elements, the listing form opened in a category with that category's item specifics, and
eBay's validation (required item specifics, standard sizes, the conditions a category takes, the
lowest price, a seller without shipping), from the fake eBay API's category fixture
(`packages/marketplaces/src/ebay/fake/taxonomy.json`), so both fakes know the same categories.
It also has listing pages with their times, Seller Hub's end page, and its active and sold
listings with pagination. It can inject each failure:

- eBay's security check page
- a CAPTCHA widget on a page
- a sign-in code step
- a logged-out session
- 429 and 5xx pages, and a 5xx that hides an applied change
- a form refusal
- an answer that comes after the step's timeout
- a stale read
- a redesigned page

Four test files cover it:

- `adapter.conformance.int.test.ts` runs the shared adapter conformance suite.
- `adapter.int.test.ts` covers the eBay flows and each check.
- `sale-check.int.test.ts` covers a sale check on real Postgres: a sale on the Sold page is
  recorded once by its order number and starts the auto-delist, and a connection that switched to
  the API is no longer checked.
- `mapping.test.ts` covers the mapping tables, the payload, and how prices and times are read.

`packages/automation/src/adapters.test.ts` covers the routing: automation for a linked session,
the API ahead of it, and assisted otherwise.

Run the fake by hand with `npm run dev:fake-ebay-site` (`FAKE_EBAY_SITE_URL`, see `.env.example`).
In development and tests, `FAKE_EBAY_SITE_URL` points eBay's automation adapter at the fake.
Otherwise `FAKE_AUTOMATION_SITE_URL`'s generic fake site stands in for eBay. With neither set, the
adapter runs against ebay.com. The fake eBay of the API adapter (`npm run dev:fake-ebay`) is a
different fake: it serves the Trading and REST APIs, not the website. Link accounts opens the fake
site's `/signin/` in development.

## Live verification

Listora reads eBay's seller pages only through a seller's own session. So the paths and selectors
in `site.ts` and `pages/` are Listora's model of eBay's US site, and they were not checked against
the live site while building this. The first linked session should confirm them, ideally with the
product owner watching. Check each of these in order:

1. The sign-in page the app opens, and the cookies a signed-in session holds on `ebay.com`.
2. Seller Hub's overview path and its marker element.
3. On the listing form:
   - the address that opens it in a category, and the category it shows
   - the photo input
   - the title and Custom label fields
   - the item specifics fields, their names, and Add item specific
   - the condition options and their values (eBay's condition ids)
   - the condition description, and the description editor's HTML view
   - the Buy It Now price field and its format
   - the seller's business policies
   - the List it and Revise it buttons, and the validation message
4. On the listing page: its path and item number, the title, the price, the sold and ended
   notices, and the "Last updated" line with its time format.
5. The revise and relist forms' addresses, and what eBay shows for a listing it can't revise.
6. The end page: its path, the reasons, and the End listing button.
7. Seller Hub's active and sold listings: their paths, pagination, the Custom label column, the
   order number, the sale price, and the sale time.
8. eBay's security check page and its sign-in code step.

When the live site differs, the step stops before it sends anything and the user does it, so this
check can never cause a false success. Fixing a mismatch means changing one page module.
