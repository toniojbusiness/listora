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
| `data/catalog.json`     | Poshmark's whole catalog, read from its own listing form (see "Mapping")       |
| `data/refresh.ts`       | Rewrites `catalog.json` from the form, and prints what changed                 |
| `catalog.ts`            | The catalog's lookups and the canonical category map                           |
| `sizes.ts`              | Turning a tag's size into Poshmark's size                                      |
| `colors.ts`             | The canonical color map                                                        |
| `conditions.ts`         | The canonical condition map                                                    |
| `prohibited.ts`         | What Poshmark prohibits, refused before anything is sent                       |
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

**Source.** Poshmark's listing form holds Poshmark's whole catalog in its page state
(`$_listing_editor.catalogMeta`, with `catalogDisplayGroupingData` for its display groups, and
the conditions in `featureSettings.featureSettingsV3.web_resell_v2_guest.conditions`). Listora
keeps it as versioned data, `data/catalog.json`, read on the captain's session on 2026-10-27
(Poshmark's catalog says it last changed on 2026-10-12): 6 departments (Women, Men, Kids, Home,
Pets, Electronics), 114 categories, 633 subcategories, and every category's size sets with their
US sizes (46 distinct sets). Names are the ones the form shows.

**Refreshing it.** `data/refresh.ts` reads the form read-only (nothing is filled in or saved),
rewrites `catalog.json`, and prints each category it added, changed, or dropped:

```sh
# From a Chrome where a seller is signed in to Poshmark, listening for DevTools on a port:
node packages/automation/src/poshmark/data/refresh.ts --cdp http://127.0.0.1:9333
# Or from a dump of the same values (FORM_EXPRESSION in refresh.ts, copied from DevTools):
node packages/automation/src/poshmark/data/refresh.ts --from dump.json
```

Then run `npx vitest run packages/automation/src/poshmark`: `mapping.test.ts` fails when the
canonical map names a place the new catalog no longer has, or the counts changed.

**The form.** Every category has the same form (read on the captain's session, 2026-10-27, for
every category of every department): photos, title, description, the category (department,
category, optional subcategory with a "None"), the size, the condition, the brand, up to two
colors, style tags, the original and listing prices (the Listing Price dialog with Automate
Offers), availability, and the private SKU, cost, and notes. Poshmark's prepaid label covers
shipping, so the form has no shipping or weight field. What differs by category is the size:

| Form shape                                                  | Example                    | How Listora fills it                                       |
| ----------------------------------------------------------- | -------------------------- | ---------------------------------------------------------- |
| Several size sets, a tab each                               | Women's Tops, Men's Shirts | The set's tab, then the size's button                      |
| Sizes whose button shows a label, not the id                | `Neck 15.5`, `Waist 32`    | The button by its label (`label` in the data)              |
| One size, chosen by the form with the category              | Bags, Home Accents, Pets   | Nothing: the form shows the size already (`chosen`)        |
| Kids' Baby, Girls, and Boys sets                            | Kids' Shirts & Tops        | The set the size names (`Boys 8`), never guessed           |
| A category inside a display group                           | Women's Kurtas             | The group ("Global & Traditional Wear"), then the category |
| A category without subcategories                            | Men's Other                | No subcategory                                             |
| A form whose picker opens on a chosen category's department | Any edit form              | "All Categories" first, then the department                |

The pickers show a size by what Poshmark calls it once chosen (`2T (Girl)`, `OS (Baby)`), and
the condition picker shows Poshmark's own labels (`New With Tags (NWT)`, `Like New`, `Good`,
`Fair`).

**Catalog** (`catalog.ts`). Each canonical category maps per department (women's, men's, kids')
onto Poshmark's category and, where one fits, its subcategory, by the most specific canonical
prefix (`clothing/tops/blouses` → Women / Tops / Blouses). Unisex items go under Men; home items
(`home/decor`, `home/kitchen`, `home/bedding`) go to Home whatever their department. A few
canonical categories have no Poshmark place (men's dresses and skirts, matching sets, `other`);
for those the seller picks one. The seller can pick any of the 747 places in the List flow
(`categories.ts` offers every category and subcategory), and the listing names it in its
`categoryRef` as `Department/Category[/Subcategory]` (`Electronics/Headphones/Over-Ear Headphones`).

**Sizes** (`sizes.ts`). The tag's size is normalized (`Medium` → `M`, `2XL` → `XXL`, `XL Tall` →
`XLT`, `32x30` → `32`, `10 1/2` → `10.5`, `34DD` → `34E (DD)`, `S Petite` → `SP`, `Queen` →
`QUEEN`, `6-9 months` → `6-9MB`) and kept only when one of the category's sets has it. Juniors and
Maternity sets are never picked, since nothing on an item says it is either. A kids' size that
Girls and Boys both have (`8`, `4T`) needs the size to name one (`Girls 8`, `Boys 8`); validation
says so. UK and EU sizes are never converted.

**Colors** (`colors.ts`). Poshmark offers 15 colors and takes two. The item's first two colors
Poshmark has are chosen (beige as Tan, navy as Blue; multicolor has none); an item without colors
leaves the picker as it is.

**Conditions** (`conditions.ts`). Poshmark offers four (its codes and labels from the form):

| Listora               | Poshmark                  |
| --------------------- | ------------------------- |
| `new_with_tags`       | `nwt` New With Tags (NWT) |
| `new_without_tags`    | `uln` Like New            |
| `new_with_defects`    | `ug` Good                 |
| `pre_owned_excellent` | `uln` Like New            |
| `pre_owned_good`      | `ug` Good                 |
| `pre_owned_fair`      | `uf` Fair                 |

**Prohibited items** (`prohibited.ts`). Poshmark deletes listings it prohibits and suspends
sellers who keep listing them ("What can I sell on Poshmark?", support.poshmark.com, read
2026-10-27), so Listora refuses them before anything is sent: makeup and personal care
(Makeup, Skincare, Hair, Bath & Body, Grooming, Kids' Bath, Skin & Hair) and underwear (the
item's own category, or Poshmark's Panties, Boxer Briefs, Boxers, Briefs, and Kids' Underwear)
unless new with tags; and a title or description that names a replica, "inspired by" a brand,
an N95 mask, or what Poshmark's labels can't ship (nail polish, perfume, cologne, aerosols).

**Rules** (`payload.ts`). Titles at most 80 characters and descriptions at most 1,500
(Poshmark's Bulk Upload template); a description; prices in whole dollars (every price on
Poshmark's pages was) from $3 (`app_listing_fee__us.minimum_selling_price`) to $1,000,000
(`max_listing_price_amount`); at most 16 photos; and a catalog, size, and condition. The
variant's `Brand`, `Size`, and `Original Price` aspects win over the item's values.

## What is verified, and what is not yet

Mapped on the seller's own session (2026-10-26 and 27; Poshmark's own public code first, then
the evidence of runs that stopped, then the form on the Mac), and run from the iPhone on
Listora's own test listings:

- **List** (phone, 51 seconds; Mac, 2026-10-27, about 3 minutes with the profile's pacing):
  photos and Poshmark's cover-photo editor (its Apply), title and description, the listing and
  original prices (the price field opens a dialog whose Automate Offers Listora turns off), the
  brand, the category, size, condition, and color pickers, the private
  SKU behind "show details", and Next then List. After List Poshmark shows the closet, which
  doesn't name the new listing, but the form named it from the moment it opened: its photos
  section carries the new listing's id in `data-et-prop-listing_id`, and a listing keeps that
  id once listed (its id dates from the form's opening, not from its List). So the same run
  reads the new listing on its own page right away (a page that still holds it back, `hidden`,
  names it too). The closet can lag minutes behind a new
  listing (3 to 20 minutes on the captain's closet, 2026-10-27), so finding it by its SKU there
  (the closet searched by title, each candidate's edit form, whose data holds the SKU at
  `$_listing_editor.post.seller_private_info.sku`) is only the fallback when the form named no
  id or the page never showed it.
- **Read** and **End** (phone): the listing page, availability Not For Sale. A listing off the
  site answers 404, and its page holds Poshmark's record of what became of it
  (`listingDetails.error`, a `PostRemovedError` whose `params.post_info.status` says): `archived`
  once its seller deleted it, which is definitive, and `hidden` once Poshmark hid it, which is
  not (Poshmark can show it again), so End and Relist say Poshmark is hiding the listing.
- **Used underwear:** Poshmark doesn't support it (its own removal reasons name "used makeup or
  underwear"), and it hid Listora's test listing of used boxer briefs minutes after a price
  change (2026-10-27). Listora lists underwear on Poshmark only new with tags, and refuses it
  otherwise before anything is sent.
- **Relist** (phone): a listing Poshmark removed is listed again as a new listing.
- **Change price, End, and Relist back to For Sale** (Mac, the captain's signed-in browser,
  2026-10-27): Update opens the same share step a new listing's Next does, and its List This
  Item saves the change.
- **Poshmark's review after a change** (Mac, 2026-10-27): after a change Poshmark reviews the
  listing (`status: "for_review"` in its record), and on the captain's account the review lasted
  over 40 minutes after a price change. Its page still embeds the listing with the change for
  its seller, but a buyer gets the 404 page (`PostRemovedError`, `post_info.status`
  `for_review`). So a listing under review can still be ended, repriced, revised, and relisted,
  an ended or sold one reads as what it is, and one for sale reads as not live yet (never as
  gone) until Poshmark publishes it again. Before this, Listora read a listing under review as
  absent and refused to end it ("not on Poshmark yet").
- **Every form shape, on the real form** (Mac, 2026-10-27, filled with Listora's own form code
  and read back, never submitted): Women's Tops (Standard), Women's Jeans (Plus), Women's Kurtas
  (in a display group), Men's Shirts in a neck size and new with tags, Men's Jeans in a waist
  size, Men's Shirts Big & Tall, Men's Other (no subcategory), Kids' Shirts & Tops (Boys), Kids'
  One Pieces (Baby), Kids' Toys (one size), Home Bedding (Queen), Home Accents (one size),
  Pets Dog Toys, and Electronics Headphones, with their colors. Each picker showed exactly what
  the listing asked for.
- **Deleting** a listing (by hand, for Listora's test listings): its page's Not For Sale dialog
  has "Delete Listing?" and then Delete, after which the page answers 404 with `archived`.
- **Not yet:** a revise of the other details, and a sale check.

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
