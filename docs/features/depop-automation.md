# Depop automation

Depop's Selling API is private, and Listora's partner access is not granted yet (gate G-Depop,
[depop.md](depop.md)). Depop permitted the product owner to automate their own account (decision
D1, revised 2026-10-24). So until the API is granted, Listora acts on Depop through the seller's
own browser session, on the seller's iPhone ([phone-execution.md](phone-execution.md); Depop
refuses Listora's cloud browser runner, [automation.md](automation.md)). The code is in
`packages/automation/src/depop/`. The runner's safety rules apply to every step:

- Every action is human-paced: 0.3 to 0.8 seconds before each one on Depop (`DEPOP_PACING`,
  agreed with the product owner 2026-10-27; the other marketplaces wait 0.8 to 2.5). Each
  seller's account gets a limited number of runs.
- The first CAPTCHA, bot check, login page, or login-code step stops the run. Listora never tries
  to get past one. The step becomes the user's assisted task, and the connection waits until the
  seller logs in again in the app.
- Passwords are never stored, only the session cookies, encrypted.
- Every change is confirmed by a read-back of the product, as Depop's own pages read it.

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

| Operation  | How                                                                                                                     | Confirmed by                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Create     | Fills the sell form (`/products/create/`), adds the photos last, then clicks Post. Only that click can change anything. | One read: status, text, price, and change time |
| Revise     | Fills the edit form (`/products/edit/<slug>/`) with every detail except photos, then clicks Save                        | The same                                       |
| Price      | Fills only the price on the edit form, then clicks Save                                                                 | The same                                       |
| End        | **Delete listing** on the seller's own product page, confirmed in Depop's dialog                                        | The product page answers 410 Gone              |
| Relist     | Posts a **new listing** from the listing's content, under a new slug. A listing still on sale is left as it is.         | The new product reads for sale (`active`)      |
| Mark sold  | Not automated: after a sale elsewhere, the auto-delist ends the Depop listing                                           |                                                |
| Read       | The product's page (for its 410), then the seller's own product from Depop's web API, as the edit page loads it         |                                                |
| Sale check | The seller's sold items (`/sellinghub/sold-items/`): its no-sales note reads as none; sales fail visibly (not mapped)   |                                                |
| Listings   | The seller's listings for sale from Depop's web API, as the selling hub loads them, 24 at a time, up to 25 pages        |                                                |
| Health     | The selling hub (`/sellinghub/`)                                                                                        |                                                |

- **Ending is a deletion.** Depop has no way to take a listing off sale and put it back later,
  so Listora ends a Depop listing by deleting it, and a relist is a new product, as with Depop's
  API. A deleted product's page answers 410 Gone, a definitive absence, so the read-back confirms
  the end (and clears the listing's id, so a later relist posts a new listing). A listing that
  is already sold or deleted is not touched.
- A sold or deleted listing cannot be edited. Listora refuses those steps and tells the user to
  relist the item as a new listing.
- `listListings` reports each listing exactly as a read by its slug would, with its revision.
  Sold and deleted listings are not among those for sale. It reports `complete: false` when the
  page limit is reached.
- A sale check reports each sold item as one order. Its id is the product slug: Listora lists one
  of each item, so a Depop listing sells once.
- **Boost is never turned on.** The sell form's "Boost your listing" adds a 12% fee when the item
  sells. Listora turns it off if Depop drew it on (a test listing on the captain's account once
  came out boosted), and checks it is off before posting.

## Reads: Depop's own web API

Depop's pages load their data from Depop's web API (`webapi.depop.com`), sending the session's
token (the `access_token` cookie) as a bearer token. Listora reads the same way, in the page,
through `PageDriver.apiGet` ([automation.md](automation.md#how-it-works)), only ever with a GET
(`pages/api.ts`; every change still goes through Depop's pages):

- **One product**: `GET /presentation/api/v1/products/by-slug/<slug>/edit-listing/`, what the
  edit page loads: the product's `status` (`STATUS_ONSALE` is `active`, `STATUS_SOLD` and
  `STATUS_MARKED_AS_SOLD` are `sold`, `STATUS_DELETED` and `STATUS_BANNED` are `ended`), its whole
  `description`, its `pricing` (the price a buyer pays now, `final_price_key`), and its
  `updated_at`. Only its seller gets it; Depop answers 404 for a product it deleted.
- **The seller's listings**: `GET /api/v1/shop/products/?statusFilter=selling` (and `sold`), what
  the selling hub loads: newest first, 24 at a time with a cursor, each with its `status`,
  `description`, `price`, and `dateUpdated`.

A read opens the product's page first: a 410 Gone there is the definitive absence the end is
confirmed by, and a 404 never counts (it could be a listing not visible yet, as Depop says of its
API: "A newly created listing can take a short time to become retrievable"). For a product the
API doesn't give its seller, the page's own data is read instead (`product-page.ts`, its App
Router rows and schema.org price), without a change time.

**Freshness.** Each read carries Depop's last change time as its revision
(`readFreshness: 'revision'`, [operations.md](operations.md)), so one matching read confirms a
change. Before 2026-10-27 the pages showed no change time, and every change was confirmed by two
matching reads 15 seconds apart.

## Finding a listing again

Depop's sell form has a SKU field, but Depop takes a SKU only once, even after the listing is
deleted (a relist under the same SKU is refused, "There was a problem listing your product",
2026-10-27). So the field stays empty, and the scripts put a line that names the listing's SKU
into the listing text, after the copy and before the hashtags (adapter/sku-line.ts, shared with
Mercari, [mercari.md](mercari.md#finding-a-listing-again)):

```text
Classic trucker jacket in medium wash.

SKU: AJ-000184

#vintage #denim
```

Reads remove the line and the hashtags again, so the description Listora checks is the listing's
own copy. After a Post, Depop's Done page doesn't name the new listing, so the same run looks for
the line among the seller's newest 24 listings for sale (one API read). A create whose answer was
lost, and every later attempt of a create or relist, first looks for it the same way, and reports
that listing instead of posting a second one. The line counts against Depop's 1,000-character
limit, so validation keeps 71 characters free for it: the copy and hashtags can be at most 929
characters.

## The taxonomy

Depop's whole category tree and the sell form's fields for each kind of category are versioned
data in the repository, `taxonomy/taxonomy.json`, read from Depop itself:

- every department (Men, Women, Kids, Everything else), its categories (Tops, Footwear, Home,
  Beauty, Art, Toys, ...), and each one's product types: 281 in all (2026-10-27);
- for each product type in each department, its US size list (13 lists: men's tops, bottoms with
  waists in inches, `32"`, shoes in halves, `US 9.5`, women's numeric `00` to `36`, bras, kids'
  ages and shoe ranges, ...), with every label exactly as the form offers it, or none;
- the item specifics the form offers for it (material, occasion, fit, bag type, ...), and every
  attribute's values with how many the form takes (colours: 2, materials: 4, styles: 3, ...);
- the hashtags Depop's form refuses.

`npm run depop:taxonomy --workspace @listora/automation` refreshes it (`taxonomy/refresh.ts`): in
a background tab of a Chrome where a seller is signed in to Depop (`DEPOP_TAXONOMY_CDP_URL`,
`.env.example`), it reads what the sell form loads (`/presentation/api/v2/search/filters/category/`,
`/presentation/api/v1/attributes/`, `/presentation/api/v1/attributes/categories/size-mapping/`,
`/presentation/api/v1/listing/banned-hashtags/`), the way the form reads it, and writes the US
names and sizes. It only reads. Refresh it when a listing stops with "has no category group" or
"offers no size", review the diff, and commit it with the mapping changes `mapping.test.ts`
then asks for.

The sell form follows the same data: Kids shows no gender picker on the web, every field but the
category, size (for sized product types), condition, price, and shipping is optional, and the
package size defaults to Depop's choice for the category (left as it is).

## Mapping Listora's details to Depop's

The mappings are tables in the repository, checked against the taxonomy by `mapping.test.ts`.

- **Text.** Depop listings have no title. The description field gets the copy, the SKU line, and
  the hashtags (`depopDescription`, shared with the item analysis and the API adapter). Listora's
  title is never posted and never read back (`capabilities.title` is `none`).
- **Category** (`categories.ts`): each of Listora's canonical categories names Depop's category
  and its product types in order of fit, and the first that Depop offers in the item's
  department is the one: women's items go to Women, men's and unisex ones to Men (Depop has no
  unisex department and lists unisex clothing under Men), kids' to Kids, and home items to
  Everything else whoever they are for. A men's blouse is a Shirt (men's tops have no Blouses),
  women's underwear Panties and men's Boxers and briefs. The test checks every canonical category
  in every department maps to a product type Depop offers there, except the few Depop has none
  for (a men's dress, kids' underwear, kids' suits). Those, and `other`, need the listing to name
  its category itself (`variant.categoryRef`): Depop's three names joined with `>`
  (`Women > Footwear > Boots`, and the former `Womenswear` names), its ids joined with `/`
  (`womenswear/footwear/boots`), or a product type id (`boots`). Any of the 281 can be named, so
  beauty, art, toys, and the rest list too; the List flow's picker offers them all.
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

- **Size** (`sizes.ts`): the label in the product type's own size list that names the tag size.
  Some examples:
  - `Small` becomes `S`, `2XL` becomes `XXL`, and `XXXL` becomes `3XL`.
  - Numbers are women's sizes where the list has them (`8`), waists in inches where it has only
    those (`32` and `32x30` become `32"`), and kids' ages on a kids' list (`8` and `8T` become
    `8 years`, `6-9M` becomes `6-9 months`).
  - US shoe sizes come in halves (`10 1/2` becomes `US 10.5`); kids' shoe sizes fall in Depop's
    ranges (`9.5` becomes `9-9.5`). UK and EU shoe sizes are not mapped.
  - Bras keep their band and cup (`34B`).

  A product type with a size list needs a size that maps; validation names a few of the sizes it
  offers otherwise.

- **Colours and material** (`attributes.ts`): the item's colours (up to 2) and, where the product
  type offers one, its materials (up to 4), as Depop's own values (`gray` is Grey, `beige` Tan,
  `multicolor` Multi, `spandex` Elastane / Lycra / Spandex). A colour or material Depop has no
  value for is left out. Depop's other optional details (style, age, source, occasion, fit, and
  each category's type) are left for the seller.
- **Brand**: the script types the brand into Depop's brand search and picks the suggestion that
  matches exactly, ignoring case, or else the one brand Depop lists under a longer name (`PSD`
  is `PSD Underwear`). The form takes only brands from Depop's list. When none matches, Listora
  types no brand, and the brand Depop suggests from the photos, if any, stays, as it does for a
  seller filling the form by hand.
- **Shipping**: left as the seller set it up on Depop. The form starts with the seller's own
  shipping choice and Depop's package size for the category. A seller who has set none up gets
  Depop's own message asking for one, which Listora shows as a rejection the user can fix.
- **Limits** (`payload.ts`, from the API adapter's `DEPOP_LIMITS`):
  - text: 1,000 characters, hashtags and the SKU line included; no email addresses
  - hashtags: at most 5, the copy's own included, none that Depop refuses
  - prices: at least $1.00, in dollars and cents
  - photos: 1 to 8, uploaded in posting order (the first is the cover)

## Prohibited items

`prohibited.ts` refuses, before anything is sent, a listing Depop would remove (and hold against
the seller's account), from Depop's list of prohibited and restricted items ("What are Depop's
prohibited items?", Depop Help Centre, last updated May 2025, read 2026-10-27):

- the hashtags Depop's form refuses (the taxonomy's list);
- words that name what Depop prohibits in any category: counterfeits, event tickets, gift cards
  and vouchers, raffles and mystery boxes;
- outside clothing and shoes, the items its list names: technology and electronics (phones,
  headphones, consoles, laptops, smartwatches, chargers, hair tools), tobacco and vapes, weapons,
  drugs, medical products, alcohol, and the restricted products for babies (car seats,
  strollers, cribs). Clothing is left out, where the same words are a print or a brand on a tee
  ("PlayStation graphic tee");
- used perfume and cosmetics (Depop takes them only unused);
- underwear the listing says is unwashed. Depop takes clean, used underwear (its list prohibits
  only "unclean and/or unwashed underwear"), unlike Poshmark and Mercari (`adapter/underwear.ts`).

Each refusal is a validation issue (`prohibited`) that says what was found, so the seller can fix
a listing it caught by mistake. It is a floor, not Depop's review: Depop still decides.

## Filling the form

The script fills the sell form in this order: the description, the category (searched for by
the product type, then by the category for a common name such as "Other", and picked in its
group), the size, the brand, the condition, the colours and material, and the price, then turns
Boost off and adds the photos **last**. Depop fills in item info from photos (a category, brand,
condition, and colour: "Item info added"), but only into fields still empty, so Listora's values
are in place first instead of waiting up to 15 seconds for Depop's fill (as before 2026-10-27).
Depop then needs a moment to take the photos (it uploads them to its image server; a Post before
that is refused with "Please insert at least one image"), so the script waits until every photo
shows as added. A field Depop's fill still took over is put back once, and the form is checked
to show every pick (product type, size, condition, Listora's brand, colours, material) and Boost
off before the Post step starts.

Each picker is a combobox as Depop draws it: an input that shows the pick, a toggle button, and
a menu that keeps its options while closed. A multi-value picker (colours, material) shows each
pick with its own "Remove <value>" button.

## Structure

```text
depop/
  adapter.ts       the scripts, on the AutomationAdapter base
  scripts.ts       how each operation is done on Depop's pages
  site.ts          Depop's origins (site and web API), paths, slugs, pacing, challenge signs, private page parts
  payload.ts       the payload, validation, the listing text
  categories.ts conditions.ts sizes.ts attributes.ts   the mapping tables
  prohibited.ts    the items Depop prohibits
  taxonomy/        Depop's category tree and form fields (taxonomy.json), its schema, its refresh
  pages/           one module per page or API, with its selectors and data keys:
                   hub-page, listing-form (the sell and edit form), product-page, edit-page,
                   sold-items-page, api (the web API reads); page-data and flight-data read data
  fake/            the fake Depop site, its conformance driver, its CLI
```

A page module throws `PageChangedError` when its page is not as it expects. The error message
names the page and what is missing, for example "Depop's listing form has no category group
"Men > Hovercraft"; the page may have changed.". The run records it as `element_missing`:

- If it happens before anything was sent, the step falls back to the user's task.
- If it happens after the change was sent, the outcome is unknown, and a read-back decides.
- In a read, the read fails and is retried.

So a change to Depop's site costs at most an assisted task. Fixing it means changing one page
module's selectors or data keys, or refreshing the taxonomy.

## Local development and tests

The tests never send traffic to Depop. They run in a real headless Chromium against the fake
Depop site (`fake/fake-depop-site.ts`, its pages in `fake/fake-depop-pages.ts`). The fake copies
Depop's pages and API as the seller's session showed them (2026-10-26 and 27): the selling hub,
the product page's streamed rows and schema.org price with Delete listing and its dialog, the
sell and edit form with every product type of the taxonomy (category groups, size lists, the
brand search, the condition, the colour and material pickers with their Remove buttons, Boost,
photos that show as added a moment after they are picked, and Depop's item info from them where a
field is empty), the Done page after Post, a 410 for a product deleted for good, the sold items
page, and the web API's reads of the seller's own product and listings (with the session's token
as the bearer token, which its pages keep in the `access_token` cookie). It can also inject each
failure:

- a bot-check page ("Please verify you are a human", a 403), on a page or in the API's place
- a CAPTCHA widget on a page
- a login-code step
- a logged-out session
- 429 and 5xx answers, and a 5xx that hides an applied change
- a form refusal
- an answer that comes after the step's timeout
- a stale read
- a redesigned page
- a form that starts with Boost on (`boostByDefault`)

Four test files cover it:

- `adapter.conformance.int.test.ts` runs the shared adapter conformance suite.
- `adapter.int.test.ts` covers the Depop flows and each check.
- `mapping.test.ts` covers the taxonomy, the mapping tables, and the payload;
  `prohibited.test.ts` the prohibited items; `taxonomy/refresh.test.ts` the refresh.

Run the fake by hand with `npm run dev:fake-depop-site` (`FAKE_DEPOP_SITE_URL`, see
`.env.example`). In development and tests, `FAKE_DEPOP_SITE_URL` points Depop's automation
adapter at the fake, which then serves the API's reads too. Otherwise `FAKE_AUTOMATION_SITE_URL`'s
generic fake site stands in for Depop. With neither set, the adapter runs against depop.com. The
fake Depop of the API adapter (`npm run dev:fake-depop`) is a different fake: it serves the
Selling API, not the website.

## Live verification

Verified on the captain's own account (2026-10-27) on the Mac, with Listora's own phone runtime
and scripts in a background tab of the signed-in Chrome, on the captain's real inventory items,
each one listed, confirmed, repriced, ended, relisted, and ended again, every listing deleted
after (Depop's own list of the seller's listings read back empty):

| Item                                                   | List (send + confirm) | Price      | End         | Relist      | End again   |
| ------------------------------------------------------ | --------------------- | ---------- | ----------- | ----------- | ----------- |
| Comfort Colors tee, unisex (Men > Tops > T-shirts, XL) | 28.8 s + 2.8 s        | 5.0 + 3.1  | 8.4 + 8.9   | 28.0 + 2.8  | 6.1 + 1.4   |
| Shaka Wear tee, unisex (Men > Tops > T-shirts, XXL)    | 23.7 s + 3.5 s        | 7.7 + 4.0  | 9.6 + 3.3   | 34.9 + 4.4  | 7.4 + 2.0   |
| PSD boxer briefs, used (Men > Underwear > Boxers, XL)  | 29.7 s + 3.1 s        | 5.2 + 2.6  | 6.7 + 1.6   | 28.9 + 3.3  | 6.8 + 2.3   |
| Before (2026-10-27, the earlier scripts, same tee)     | 61.5 s + 20.9 s       | 9.0 + 21.6 | 10.3 + 19.8 | 47.8 + 20.6 | 10.0 + 19.0 |

Confirm times include opening a fresh background tab per read on the Mac (most of the 8.9 s); the
read itself takes 1 to 3 seconds. Every listing came out with Boost off and Listora's own colour,
brand, and size.

The captain's inventory had only those three items, so every other kind of form was verified by
filling it without posting (the same scripts up to a complete form with its Post button, then
leaving the page): one product type for each of the 17 form shapes (department and size list):
Men's tops, bottoms (`32"`), outerwear, shoes (`US 10.5`), underwear, and unsized accessories;
Women's tops, bottoms (`8`), dresses, outerwear, shoes (`US 8`), underwear (`34B`), and bags; Kids'
clothing (`8 years`), shoes (`11`), and accessories; and Everything else (Home accessories, and
Makeup brand new).

Still to verify: a sale check with a sale (the account has none), and a run on the iPhone itself
(the web API's reads from the app's web view).

When the live site differs, the step stops before it sends anything and the user does it, so a
change can never cause a false success. The run logs what the page has instead
([automation.md](automation.md#how-it-works), "When a page changes"). Fixing a mismatch means
changing one page module.
