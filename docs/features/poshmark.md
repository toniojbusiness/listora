# Poshmark automation

Poshmark has no API for crosslisters. It granted the product owner permission to automate their
own account (decision D1, revised 2026-10-24), so Listora automates Poshmark in the cloud: the
browser runner ([automation.md](automation.md)) acts in the seller's own Poshmark
session, which the seller logs into from the app. Every safety rule of the runner applies:
human pacing, per-seller rate limits, a stop at any CAPTCHA, bot check, login or verification
step, or page off poshmark.com, no stored password, and a read-back for every change. A step
that has to stop goes to the user as the assisted task it would have been without automation.

The code is in `packages/automation/src/poshmark/`:

| File                    | What it holds                                                                  |
| ----------------------- | ------------------------------------------------------------------------------ |
| `adapter.ts`            | The scripts for every operation, on the automation adapter base                |
| `payload.ts`            | The pure payload builder and Poshmark's rules (golden files in `__golden__/`)  |
| `catalog.ts`            | Departments, categories, size sets, and the canonical category map             |
| `sizes.ts`              | Turning a tag's size into Poshmark's size id                                   |
| `conditions.ts`         | The canonical condition map                                                    |
| `site.ts`               | Poshmark's URLs                                                                |
| `pages/`                | One module per page: every selector and every data key the adapter reads       |
| `fake/fake-poshmark.ts` | The fake Poshmark that tests and development use (`npm run dev:fake-poshmark`) |

## Operations

| Listora       | On Poshmark                                                                                                                  | Read back        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| create        | The listing form (`/create-listing`): photos in posting order (the first is the cover), every field, Listora's SKU, For Sale | The listing page |
| revise        | The edit form (`/edit-listing/<id>`): title, description, category, size, condition, brand, prices (photos stay)             | The listing page |
| price         | The edit form: the listing price                                                                                             | The listing page |
| end           | The edit form: availability Not For Sale                                                                                     | Status `ended`   |
| relist        | The edit form: availability For Sale (a sold listing cannot be relisted; that is a rejection)                                | Status `active`  |
| mark sold     | Not needed: Poshmark marks its own sales sold                                                                                |                  |
| read          | The listing page by id; by SKU, see "Finding a listing by its SKU"                                                           |                  |
| health        | The listing form, which only a logged-in seller sees                                                                         |                  |
| sale check    | The seller's sold items (`/closet/<username>?availability=sold_out`), up to 5 pages of 48                                    |                  |
| list listings | The whole closet (`availability=all`, newest first), up to 50 pages of 48, for imports and drift checks (`listListings`)     |                  |

**Ending is Not For Sale, never a deletion.** The listing can no longer be bought, keeps its
likes and comments, and comes back with a relist. A deletion cannot be read back (Listora has
not seen what Poshmark answers for a deleted listing), and Poshmark's guidelines name deleting
and reposting.

**Reads.** Listing and closet pages embed their data as `window.__INITIAL_STATE__`, with the
listing records Poshmark's own API returns. The adapter reads those (exact prices, status codes,
and change times) rather than the visible text. The script that embeds them removes itself from
the page as soon as it ran, so a loaded page has them only in its global, which the page driver
reads in the page's own script world (`pageData`); the fake Poshmark removes its script the
same way. Statuses map from `inventory.status`:
`available` and `reserved` (a buyer is checking out) are `active`, `not_for_sale` is `ended`,
and `sold_out` is `sold`. The revision is the newest of `updated_at`, `status_changed_at`, and
`inventory.status_changed_at`, in milliseconds. Those times have one-second resolution; every
Listora change is its own browser session, at least two seconds after the last
(`PACING_FLOOR.sessionGapMs`), so each one gets a newer revision. An absence is never
authoritative: a missing listing reads as "not found yet", never as "gone".

**Finding a listing by its SKU.** A create whose answer was lost may have gone through, so
every create first looks for its listing, and a read without the listing id does the same.
Poshmark cannot search by SKU, so Listora writes its SKU into the seller's private SKU field
(only the seller sees it), searches the closet for the title (newest first, up to 3 pages), and
opens the edit form of up to 12 listings with that exact title to compare their SKU. Without a
title (a read), the candidates are the listings created in the last 72 hours.

**Sale checks.** Poshmark's sold items show no order number, and each listing sells once, so a
sold listing is one order: `externalOrderId` is `listing:<id>`, and its sale time is the
listing's `inventory.status_changed_at`. Buyers' names and addresses are never read.

## Mapping tables

Sources: Poshmark's public pages, read logged out on 2026-10-24 (a search page, a listing page,
the Men and Women category pages, and one public closet with each `availability` filter).
Listora reads no logged-in page except through a seller's own session.

**Catalog** (`catalog.ts`). Women's and men's items map onto Poshmark's department, category,
and, where Poshmark's pages showed one, subcategory, by the most specific canonical prefix
(`clothing/tops/blouses` → Women / Tops / Blouses; `clothing/tops/bodysuits` → Women / Tops).
Unisex items go under Men. Kids' items (whose girls', boys', or baby size set Listora cannot
tell) and Home items are not mapped; the listing can name its catalog in its `categoryRef` as
`Department/Category[/Subcategory]` in Poshmark's display names (`Men/Jackets & Coats/Vests`),
and otherwise its validation asks for one.

**Sizes** (`catalog.ts`, `sizes.ts`). Each category has Poshmark's size sets with their size
ids, from the search facets (`sizesGroupedByDepartmentAndCategory`): women's Standard, Plus, and
Petite, and men's Standard and Big & Tall. Juniors and Maternity are left out, since nothing on
an item says it is either. A few categories were not in the facets and are marked "assumed" in
the table (one-size categories take `OS`; men's Swim takes the men's letter sizes). The tag's
size is normalized (`Medium` → `M`, `2XL` → `XXL`, `XL Tall` → `XLT`, `32x30` → `32`, `10 1/2` →
`10.5`, `34DD` → `34E (DD)`, `S Petite` → `SP`) and kept only when one of the category's sets
has it. UK and EU sizes are never converted.

**Conditions** (`conditions.ts`). Poshmark offers four (its codes and labels from
`featureSettings.web_resell_v2_guest.conditions`):

| Listora               | Poshmark                  |
| --------------------- | ------------------------- |
| `new_with_tags`       | `nwt` New With Tags (NWT) |
| `new_without_tags`    | `uln` Like New            |
| `new_with_defects`    | `ug` Good                 |
| `pre_owned_excellent` | `uln` Like New            |
| `pre_owned_good`      | `ug` Good                 |
| `pre_owned_fair`      | `uf` Fair                 |

**Rules** (`payload.ts`). Titles at most 80 characters and descriptions at most 1,500
(Poshmark's Bulk Upload template); a description; prices in whole dollars (every price on
Poshmark's pages was) from $3 (`app_listing_fee__us.minimum_selling_price`) to $1,000,000
(`max_listing_price_amount`); at most 16 photos; and a catalog, size, and condition. The
variant's `Brand`, `Size`, and `Original Price` aspects win over the item's values.

## What is verified, and what is not yet

Mapped on the seller's own session (2026-10-26 and 27; Poshmark's own public code first, then
the evidence of runs that stopped, then the form on the Mac), and run from the iPhone on
Listora's own test listings:

- **List** (phone, 51 seconds): photos and Poshmark's cover-photo editor (its Apply), title and
  description, the listing and original prices (the price field opens a dialog whose Automate
  Offers Listora turns off), the brand, the category, size, and condition pickers, the private
  SKU behind "show details", and Next then List. After List Poshmark shows the closet, so the
  same run finds the new listing by its SKU (the closet searched by title, each candidate's edit
  form, whose data holds the SKU at `$_listing_editor.post.seller_private_info.sku`). A new
  listing can take a moment to show in the closet, so the check then finds it.
- **Read** and **End** (phone): the listing page, availability Not For Sale; a deleted listing's
  page answers 404, definitive for a well-formed id.
- **Relist** (phone): a listing Poshmark removed is listed again as a new listing.
- **Not yet:** a price change, a revise, a relist back to For Sale, and a sale check.

Who is logged in comes from Poshmark's own store, as its app reads it: `auth.isUserLoggedIn`,
`auth.identity` (the user's id, not their handle), and the handle in `userCookies.userInfo`
(`username`, else `dh`). A closet page's records (`$_closet.listingsPostData`, its `data` and
`more`) match what `pages/closet-page.ts` reads. A selector or data key that no longer matches
ends the step as `element_missing` before anything is submitted (`PageChangedError` for data), so
the step goes to the user, the run logs what the page has instead
([automation.md](automation.md#how-it-works), "When a page changes"), and the fix is in the one
page module that names it. The fake Poshmark mirrors exactly what those modules expect.

## Development and tests

`npm run dev:fake-poshmark` serves the fake Poshmark at `FAKE_POSHMARK_URL`, which the worker's
and the runner's Poshmark adapter then drive instead of poshmark.com. Tests run only against the
fake, in a real headless Chromium: the shared conformance suite
(`adapter.conformance.int.test.ts`) and the adapter's own flows, checks, and page changes
(`adapter.int.test.ts`). No test sends traffic to Poshmark.
