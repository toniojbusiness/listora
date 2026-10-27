# Depop automation

Depop's Selling API is private, and Listora's partner access is not granted yet (gate G-Depop,
[depop.md](depop.md)). Depop permitted the product owner to automate their own account (decision
D1, revised 2026-10-24). So until the API is granted, Listora acts on Depop through the seller's
own browser session, in the cloud browser runner ([automation.md](automation.md)). The code is
in `packages/automation/src/depop/`. The runner's safety rules apply to every step:

- Every action is human-paced. Each seller's account gets a limited number of runs.
- The first CAPTCHA, bot check, login page, or login-code step stops the run. Listora never tries
  to get past one. The step becomes the user's assisted task, and the connection waits until the
  seller logs in again in the app.
- Passwords are never stored, only the session cookies, encrypted.
- Every change is confirmed by a read-back of the product's page.

## The API comes first

A seller has one Depop connection, and its mode decides which adapter serves it
(`ConnectionAwareAdapter`, [marketplaces.md](marketplaces.md#adapter-model)):

- An `api` connection always gets the Depop API adapter ([depop.md](depop.md)), whatever its
  status (or the assisted adapter while no API adapter is configured). A Depop API connection
  that needs reconnecting is never automated in the meantime.
- An `automation` connection with a working session (`connected` or `degraded`) gets this
  adapter. Without a session, it gets the assisted adapter.
- Linking a browser session to an account whose Depop connection uses the API is refused
  (`ConnectionModeConflictError`).
- An account has at most one connection per marketplace, and the OAuth connect flow
  (`completeAuthorization`, [connections.md](connections.md)) stores a grant on the account's
  existing connection with the mode `api`. So once Depop's connect is wired to that flow (a
  later task), connecting the API over an automation connection makes it an `api` one: the API
  takes over, and its sale checks stop (they run only for automation connections).

Both modes address the same products. A listing posted through the browser is known by its
product slug, and the API adapter addresses a slug through Depop's `by-slug` endpoints. So the
switch needs no data migration ([depop.md](depop.md), "SKUs are listing ids").

## What it does

| Operation  | How                                                                                                                    | Confirmed by                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Create     | Fills the sell form (`/products/create/`), then clicks Post. Only that click can change anything.                      | The product page: status, text, price               |
| Revise     | Fills the edit form (`/products/edit/<slug>/`) with every detail except photos, then clicks Save                       | The same                                            |
| Price      | Fills only the price on the edit form, then clicks Save                                                                | The same                                            |
| End        | **Delete listing** on the seller's own product page, confirmed in Depop's dialog                                       | The product page answers 410 Gone                   |
| Relist     | Posts a **new listing** from the listing's content, under a new slug. A listing still on sale is left as it is.        | The new product's page shows it for sale (`active`) |
| Mark sold  | Not automated: after a sale elsewhere, the auto-delist ends the Depop listing                                          |                                                     |
| Read       | The product's page (`/products/<slug>/`)                                                                               |                                                     |
| Sale check | The seller's sold items (`/sellinghub/sold-items/`): its no-sales note reads as none; sales fail visibly (not mapped)  |                                                     |
| Listings   | The seller's listings for sale (`/sellinghub/selling/`), up to 25 pages (`listListings`, for imports and drift checks) |                                                     |
| Health     | The selling hub (`/sellinghub/`)                                                                                       |                                                     |

- **Ending is a deletion.** Depop has no way to take a listing off sale and put it back later,
  so Listora ends a Depop listing by deleting it, and a relist is a new product, as with Depop's
  API. A deleted product's page answers 410 Gone, a definitive absence, so the read-back confirms
  the end (and clears the listing's id, so a later relist posts a new listing). A listing that
  is already sold or deleted is not touched.
- A sold or deleted listing cannot be edited. Listora refuses those steps and tells the user to
  relist the item as a new listing.
- `listListings` reports each listing exactly as its product page would, with its revision.
  Sold and deleted listings are not on the selling page. It reports `complete: false` when the
  page limit is reached.
- A sale check reports each sold item as one order. Its id is the product slug: Listora lists one
  of each item, so a Depop listing sells once.

**Reads.** Depop's pages are App Router pages (`pages/flight-data.ts`): the server streams its
React Server Components payload into inline `self.__next_f.push` scripts, whose rows hold the
data the page's queries started with. The product read finds the product's own record (its
`slug`, `status`, and whole `description`, sometimes as a JSON string inside a row) and the price
in the page's schema.org data (`script[data-testid="meta__jsonLd"]`). The seller's own product
page opens as `/products/<slug>/manage/`, and on the phone it once came without the record, a
minute after posting: the schema.org data then speaks for it (its whole description, and the
offer's availability: `InStock` is `active`, `SoldOut` and `OutOfStock` are `sold`). Product
statuses map like the API adapter's: `ONSALE` is `active`, `SOLD` and `MARKED_AS_SOLD` are `sold`,
`DELETED` and `BANNED` are `ended`.

**Freshness.** The pages no longer say when a product last changed, so reads carry no revision,
and the adapter confirms a change by reading it twice (`readFreshness: 'none'`,
[operations.md](operations.md)).

**Absence.** A 410 Gone is definitive (Depop answers it for a deleted product). A 404 never
counts: it could be a listing not visible yet, as Depop says of its API ("A newly created
listing can take a short time to become retrievable").

## Finding a listing again

Depop's web form has no seller SKU field. So the scripts put a line that names the listing's SKU
into the listing text, after the copy and before the hashtags (adapter/sku-line.ts, shared with
Mercari, [mercari.md](mercari.md#finding-a-listing-again)):

```text
Classic trucker jacket in medium wash.

SKU: AJ-000184

#vintage #denim
```

Reads remove the line and the hashtags again, so the description Listora checks is the listing's
own copy. A create whose answer was lost, and every later attempt of a create or relist after one
that may have posted (`mayHaveApplied`, [operations.md](operations.md)), first looks for the line among the newest 8 listings for sale, and reports that listing instead of
posting a second one. The line counts against Depop's 1,000-character limit, so validation keeps
71 characters free for it: the copy and hashtags can be at most 929 characters.

## Mapping Listora's details to Depop's

The mappings are static tables in the repository. Each has a test (`mapping.test.ts`).

- **Text.** Depop listings have no title. The description field gets the copy, the SKU line, and
  the hashtags (`depopDescription`, shared with the item analysis and the API adapter). Listora's
  title is never posted and never read back (`capabilities.title` is `none`).
- **Category** (`categories.ts`): the canonical category and the department (men or women) map to
  Depop's three levels, department, category, and product type, for example
  `clothing/tops/t_shirts` for women becomes `Womenswear > Tops > T-shirts`. The most specific
  entry wins. Entries whose product type Depop's own documentation names carry its id (`tshirts`,
  `jeans`, `joggers-tracksuits`, `dresses`, `swimsuit-one-piece`, `boots`,
  `other-accessories`), the same ids the API adapter sends. Kids', unisex, home, and other items
  have no mapping. Validation then asks for a category, which the listing can name itself in
  `variant.categoryRef`: Depop's three names joined with `>`, or one of those product type ids.
- **Condition** (`conditions.ts`): the API adapter's mapping (`depopCondition`), so a listing gets
  the same grade in either mode.

  | Listora             | Depop            |
  | ------------------- | ---------------- |
  | new_with_tags       | Brand new        |
  | new_without_tags    | Brand new        |
  | new_with_defects    | Used - Excellent |
  | pre_owned_excellent | Used - Excellent |
  | pre_owned_good      | Used - Good      |
  | pre_owned_fair      | Used - Fair      |

- **Size** (`sizes.ts`): the category says which size list applies (clothing, shoes, or none).
  The script picks the option whose label is the size, or starts with the size and a space.
  Some examples:
  - `Small` becomes `S`, and `3XL` becomes `XXXL`.
  - Numeric sizes up to 24 are US sizes (`8` becomes `US 8`); larger ones are waists (`32`
    becomes `W32`), and so is waist and inseam (`W32 L30`).
  - US shoe sizes come in halves (`10 1/2` becomes `US 10.5`).
  - UK and EU shoe sizes are not mapped.

  Clothing and shoes need a size that maps; validation asks for one otherwise.

- **Brand**: the script types the brand into Depop's brand search and picks the suggestion that
  matches exactly, ignoring case. The form takes only brands from Depop's list. When no
  suggestion matches, the listing is posted without a brand.
- **Shipping**: left as the seller set it up on Depop. The form starts with the seller's own
  shipping choice. A seller who has set none up gets Depop's own message asking for one, which
  Listora shows as a rejection the user can fix.
- **Limits** (`payload.ts`, from the API adapter's `DEPOP_LIMITS`):
  - text: 1,000 characters, hashtags and the SKU line included; no email addresses
  - hashtags: at most 5, the copy's own included
  - prices: at least $1.00, in dollars and cents
  - photos: 1 to 8, uploaded in posting order (the first is the cover)

## Structure

```text
depop/
  adapter.ts       the scripts, on the AutomationAdapter base
  site.ts          Depop's origin, paths, slugs, its challenge signs and private page parts
  payload.ts       the payload, validation, the listing text
  categories.ts conditions.ts sizes.ts   the mapping tables
  pages/           one module per page, with that page's selectors and data keys:
                   hub-page, listing-form (the sell and edit form), product-page, edit-page,
                   selling-page, sold-items-page; page-data reads the embedded data
  fake/            the fake Depop site, its conformance driver, its CLI
```

A page module throws `PageChangedError` when its page is not as it expects. The error message
names the page and what is missing, for example "Depop's sell page has no listing form
(form[data-testid="listingForm"]); the page may have changed.". The run records it as
`element_missing`:

- If it happens before anything was sent, the step falls back to the user's task.
- If it happens after the change was sent, the outcome is unknown, and a read-back decides.
- In a read, the read fails and is retried.

So a change to Depop's site costs at most an assisted task. Fixing it means changing one page
module's selectors or data keys.

## Local development and tests

The tests never send traffic to Depop. They run in a real headless Chromium against the fake
Depop site (`fake/fake-depop-site.ts`, its pages in `fake/fake-depop-pages.ts`). The fake copies
Depop's pages as the seller's session showed them (2026-10-26 and 27): the header's user menu
whose "Your profile" opens the shop without loading a page, the shop's product links drawn late,
the product page's streamed rows and schema.org price with Delete listing and its dialog, the
sell and edit form's comboboxes (category groups with headers, sizes, brand with its clear
button, condition), the Done page after Post, a 410 for a deleted product, and the sold items
page (its no-sales note, or receipt links). It can also inject each failure:

- a bot-check page ("Please verify you are a human", a 403)
- a CAPTCHA widget on a page
- a login-code step
- a logged-out session
- 429 and 5xx pages, and a 5xx that hides an applied change
- a form refusal
- an answer that comes after the step's timeout
- a stale read
- a redesigned page

Three test files cover it:

- `adapter.conformance.int.test.ts` runs the shared adapter conformance suite.
- `adapter.int.test.ts` covers the Depop flows and each check.
- `mapping.test.ts` covers the mapping tables and the payload.

Run the fake by hand with `npm run dev:fake-depop-site` (`FAKE_DEPOP_SITE_URL`, see
`.env.example`). In development and tests, `FAKE_DEPOP_SITE_URL` points Depop's automation
adapter at the fake. Otherwise `FAKE_AUTOMATION_SITE_URL`'s generic fake site stands in for
Depop. With neither set, the adapter runs against depop.com. The fake Depop of the API adapter
(`npm run dev:fake-depop`) is a different fake: it serves the Selling API, not the website.

## Live verification

Mapped and verified on the seller's own session (2026-10-26 and 27), from the iPhone and on the
Mac with Listora's own phone runtime and scripts in a background tab, on Listora's own test
listings:

- **List** (phone): the sell form, the Done page after Post (`/products/create/<...>/`, which
  doesn't always name the product, so the same run finds it by its SKU through the seller's shop:
  the header's user menu, "Your profile", the shop's newest product links). Posted in about a
  minute (filling 45 seconds) and confirmed by read-back. Depop draws the size picker a moment
  after the category is picked; the form waits for it.
- **Read** (phone and Mac): an active product, its owner's `manage` page, and a deleted one (410).
- **End** (phone): Delete listing on the product page and its dialog; the read-back sees the 410.
- **Relist** (phone): a relist of a deleted listing posts a new one.
- **Not yet:** a price change and a revise (the edit page's form, which also draws after load),
  and a sale check with a sale (the account has none: its sold items page shows only the
  no-sales note). The listings for import (`selling-page.ts`) still read `__NEXT_DATA__`, which
  Depop's pages no longer embed, so imports fail visibly on Depop until they are mapped.

When the live site differs, the step stops before it sends anything and the user does it, so a
change can never cause a false success. The run logs what the page has instead
([automation.md](automation.md#how-it-works), "When a page changes"). Fixing a mismatch means
changing one page module.
