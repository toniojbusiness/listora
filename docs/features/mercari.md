# Mercari automation

Mercari has no API, and it permitted the product owner to automate their own account (decision
D1, revised 2026-10-24). So Listora acts on Mercari through the seller's own browser session, in
the cloud browser runner ([automation.md](automation.md)). The code is in
`packages/automation/src/mercari/`. The runner's safety rules apply to every step:

- Every action is human-paced. Each seller's account gets a limited number of runs.
- The first CAPTCHA, Cloudflare check, login page, or login-code step stops the run. Listora
  never tries to get past one. The step becomes the user's assisted task, and the connection
  waits until the seller logs in again in the app.
- Passwords are never stored, only the session cookies, encrypted.
- Every change is confirmed by a read-back of the listing's page.

## What it does

| Operation  | How                                                                                                                  | Confirmed by                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Create     | Fills the sell form (`/sell/`), then clicks List. Only that click can change anything.                               | The listing page: status, title, text, price     |
| Revise     | Fills the edit form (`/sell/edit/<id>/`) with every detail except photos, then clicks Update                         | The same                                         |
| Price      | Fills only the price on the edit form, then clicks Update                                                            | The same                                         |
| End        | **Deactivate** on the edit page (it acts at once, with no confirmation). The listing is kept, never deleted.         | The page shows the listing as inactive (`ended`) |
| Relist     | **Activate** on the edit page of an inactive listing (same id); a listing Mercari removed is posted anew.            | The page shows the listing for sale (`active`)   |
| Mark sold  | Not needed: Mercari marks its own sales sold                                                                         |                                                  |
| Read       | The listing's page (`/us/item/<id>/`)                                                                                |                                                  |
| Sale check | The seller's "in progress" (sold, waiting to ship) and "sold" (shipped) tabs, newest first, each sale's listing page |                                                  |
| Listings   | The seller's "active" and "inactive" tabs, up to 25 pages each (`listListings`, for imports and drift checks)        |                                                  |
| Health     | The account page (`/mypage/`)                                                                                        |                                                  |

End and relist read whether the listing is active from the edit page they act on (its toggle says
Deactivate or Activate), so they load one page before they act. Only when Mercari shows no editor
(a sold listing, or one it removed, whose edit page answers an error) is the listing's own page
read to say what became of it.

- A sold listing cannot be edited or relisted. Listora refuses those steps and tells the user
  to list the item again.
- `listListings` reports the title, price, and status each tab shows. The tabs show no
  description or last-updated time, so those are `null`, and a listing found this way never
  confirms an operation. It reports `complete: false` when a tab has more than 25 pages.
- A sale check reports each sold item as one order. Its id is the item id, because a Mercari
  listing sells only once. A sale in the sold tab is done (`shipped`); one in progress may still
  wait to ship. Each sale carries the listing its page shows (photos and details), for the sold
  item Listora makes of a sale it had no listing for ([sales.md](sales.md#sales-history)). The
  first check, the sales history, reads up to 25 pages of each tab and 60 listing pages.
- A tab is read once its rows are drawn: rows that each link to their listing, or Mercari's
  empty-tab note (`ZeroListings`). Mercari draws them from its own query after the page loads,
  and in its mobile layout it shows placeholder rows that link to nothing until then. A tab that
  shows neither within 8 seconds fails the step (`element_missing`) and the check is tried
  again; it is never read as a tab without sales.

**Freshness.** The listing page's last-updated time (`updated`, in seconds, in the page's
`__NEXT_DATA__` record `ItemDetail:<id>`) is the listing's revision, in milliseconds. Mercari changes it with every edit. Automated changes are always seconds apart
because of pacing, so the revision grows with every change. A stale page shows an older time, and
the engine ignores it ([operations.md](operations.md)).

**Absence.** A deleted item's page answers 410 without the item's data, which is a definitive
absence. A sold item's page answers 410 too, but still with its data (status `sold_out`), so it
reads as sold. A plain "not found" page could be a listing that is not visible yet, so it never
counts.

## Finding a listing again

Mercari has no seller SKU field. So the scripts end every description with a line that names the
listing's SKU, for example `SKU: AJ-000184`. Reads remove that line again, so the description
Listora checks is the listing's own text. The line is how Listora avoids posting an item twice:

- Suppose a create timed out after Mercari took it, so Listora never learned the listing's id.
  The read-back finds the listing by its SKU: it opens the newest active listings (up to 8) and
  looks for the line.
- A create's later attempt after one that may have posted (`mayHaveApplied`) looks the same
  way first. If it finds the listing, it
  reports that listing and lists nothing.

The SKU is the listing's `external_sku`, or else its Listora listing id. Nothing sets
`external_sku` yet, so for now the line shows the listing id (a follow-up in the PR). The line
counts against Mercari's 1,000-character description limit. Validation keeps 71 characters free
for it, so a description can be at most 929 characters.

## The catalog

`catalog/catalog.json` is Mercari's whole category tree as its sell form offers it, with what each
category's form asks for. It is read from Mercari's own sell page on the seller's signed-in
session, the way the page reads it: its master data (`masterQuery`: every category, size group,
size, and condition) and its sell check (`sellQuery`), which says whether a category's form wants
a phone's IMEI. Read 2026-10-27:

- 3,233 categories in 17 departments (Women, Men, Kids, Home, Vintage & collectibles, Beauty,
  Electronics, Sports & outdoors, Handmade, Other, Arts & Crafts, Books, Pet Supplies, Toys &
  Collectibles, Garden & Outdoor, Office, Tools), three levels deep, in the dialog's order.
- 9 size groups, each a list with parts (`Standard`, `Petite`, `Tall`, ...): women's clothing
  (`M (8-10)`), men's clothing (`XXL (50-52)`, `Big 2X`), adult pants (`32 in.` or letters),
  suits (`40R`), women's shoes (`8.5 (39)`), men's shoes (`10 (43)`), kids' clothing (`2T`,
  `6-9 Months`, `S (6-7)`), kids' shoes (`2.5`), and bras (`34E (DD)`).
- One category's form asks for a phone's IMEI: `Electronics > Cell phones & accessories > Cell
phones & smartphones`. The sell check, sent for every phone, tablet, and wearable category, said
  no for all of them, but the form showed its IMEI field for that one once filled, so the
  refresh keeps the categories seen on the form (`IMEI_SEEN_ON_FORM` in `refresh.ts`). The form
  filling looks for the field once after the category (no wait: every other category lost a
  second there) and again once the form is filled, where a late field still stops the create.

Every listing's form has the same fields besides those: photos (1 to 12), title (up to 80
characters), description (5 words to 1,000 characters), category, brand (required: one from
Mercari's list, or its "No brand / Not sure"), condition (New, Like new, Good, Fair, Poor),
shipping (Mercari's prepaid label with the class it recommends, or ship on your own), and a
whole-dollar price from $1 to $2,000, with Smart Pricing. Mercari's form has no colour, style, or
item-specific fields. So the form's shape is its size group (or none), plus the IMEI where asked.

Refresh it with the seller's Chrome open and signed in to Mercari, started with
`--remote-debugging-port`:

```sh
node packages/automation/src/mercari/catalog/refresh.ts --cdp http://127.0.0.1:9333
```

It opens one background tab, only reads (one sell check every two seconds), stops at a sign-in
page or any check, and rewrites the file; the diff shows each category or size Mercari added,
renamed, or removed as one line. `catalog/build.ts` turns what it read into the file, and
`catalog/catalog.ts` reads it for the server (never for the phone: the payload carries the exact
names and labels the scripts pick).

## Mapping Listora's details to Mercari's

The mappings are tables in the repository, checked against the catalog by their tests.

- **Category** (`categories.ts`): maps the canonical category and the department to a category
  of the catalog. The most specific entry wins. `categories.test.ts` checks that every canonical
  category of Listora's vocabulary has a Mercari category for every department, and that every
  target is in the catalog.
  - Women's and men's items: Mercari's Women and Men trees, for example `clothing/tops/t_shirts`
    for women is `Women > Tops & blouses > T-shirts`. What Mercari's Men tree lacks (dresses,
    skirts, sleepwear, underwear) goes to `Men > Other`, whose form asks no size.
  - Unisex items: the men's category, except the kinds Mercari files only under Women
    (dresses, skirts, blouses, heels, handbags, ...).
  - Kids' items: Mercari's Kids tree files them by girls or boys and by age (`0-24 mos`,
    `2T-5T`, `(4+)`). The age comes from the size (`3T`, `6M`, anything else is 4 and up). Where
    the kind tells (a dress, swim trunks), Listora picks; otherwise the review asks girls or boys
    once, for every marketplace ([marketplace-prefill.md](marketplace-prefill.md)), and a listing
    that names neither is refused by validation, naming both (`Kids > Girls tops & t-shirts >
Girls (4+)` or the boys' one).
  - Home and other items: `Home > ...` and `Other > Other`, whatever the department.
  - A listing can name any category itself in `variant.categoryRef`: Mercari's names joined
    with `>`. Validation refuses one the catalog doesn't have. The List flow's picker offers
    every category of the catalog below its departments.
  - A category with subcategories is picked whole by the dialog's `All <category>` row.
- **Condition** (`conditions.ts`):

  | Listora             | Mercari  |
  | ------------------- | -------- |
  | new_with_tags       | New      |
  | new_without_tags    | Like new |
  | new_with_defects    | Good     |
  | pre_owned_excellent | Like new |
  | pre_owned_good      | Good     |
  | pre_owned_fair      | Fair     |

  Listora never proposes Mercari's Poor.

- **Size** (`sizes.ts`): the category's size group says which list applies, and the payload
  names the exact label to pick. The tag's size is read as one of these, the first label in the
  list's order winning (standard sizes come before petite, tall, and big ones):
  - letters by each list's own names: `Small` is `S (4-6)` for women, `XXL` is `2XL (20-22)`
    for women, `XXL (50-52)` for men, `2X` for pants;
  - numbers as the size itself (`10.5`, `32 in.`, a suit's `40` is `40R`), then as the range a
    label covers (a women's `8` is `M (8-10)`, a men's `40` is `M (38-40)`); EU shoe sizes by the
    EU size a label names (`39` is `8.5 (39)`); waist and inseam (`W32 L30`) by the waist;
  - months (`6M`, `6-9 months`, `Newborn`) by Mercari's month ranges;
  - anything else by its exact label (`2T`, `34B`, `One size`), and a bra's US cup by the cup
    the label names (`34DD` is `34E (DD)`);
  - women's sizes written with their fit or length by their parts (`adapter/adult-size.ts`): a
    petite or tall size in the list's own Petite or Tall part (`4P` is `S (4-6)` under Petite,
    `XL Tall` is `XL (16-18)` under Tall; each option's label names its part, `Petite S (4-6)`),
    a plus size by the size it spans (`16W` is `XL (16-18)`, `0X` is `L (12-14)`), an inseam
    length dropped (`0S` is `XS (0-2)`), and a tag with the waist and the size (Abercrombie's
    `27/4`) by the waist on adult pants (`27 in.`) and by the size elsewhere (`S (4-6)`);
  - a waist (`27"`, `27 in.`, `W27`, or a size the item's own size system says is a waist) only
    as a waist (`27 in.`), never as the range of a dress size;
  - a women's numeric size on adult pants, whose list has only waists and letters, by Mercari's
    own women's ranges (a `4` is `S`, as its `S (4-6)` says).

  UK shoe sizes are not mapped. A category with sizes needs one that maps; validation asks for
  one otherwise, naming a few of the category's. For a tag size the list doesn't have, a `Size`
  aspect that is one of the list's own labels is the size: the one the seller (or the AI) picked
  on the review.

- **Brand**: Mercari needs one. Once the photos are in, Mercari suggests brands as chips under
  the field and may fill one in; a suggestion that is the item's brand is kept. Otherwise the
  script searches Mercari's list and picks the brand, matched exactly, then ignoring case and
  punctuation (`Abercrombie and Fitch` is `Abercrombie & Fitch`), and again by its first word.
  A brand Mercari doesn't list, or none, is its "No brand / Not sure"; the title still names it.
- **Shipping** (`shipping.ts`): Mercari's prepaid label, paid by the buyer, with the class
  Mercari's form recommends for the listing. Listora does not know an item's weight, so it never
  picks a class itself.
- **IMEI**: a category whose form asks for a phone's IMEI is refused by validation, since
  Listora doesn't have it; if the live form asks for one anyway (Mercari draws the field once
  its own check answers, which can be after the rest is filled), the create stops before
  anything is sent (`imei_required`) and the user lists it in Mercari.
- **Limits** (`payload.ts`):
  - titles: 80 characters
  - descriptions: at least 5 words, up to 1,000 characters including the SKU line
  - prices: whole dollars, from $1 to $2,000
  - photos: 1 to 12, uploaded in posting order
- **Prohibited items** (`prohibited.ts`), refused before anything is sent, from Mercari's
  Prohibited Items list (read 2026-10-27):
  - used underwear ("items that are soiled with human materials such as used underwear"): a
    pre-owned item whose own category is underwear. New underwear lists.
  - replicas and counterfeits: a title or description that calls the item a replica,
    counterfeit, knockoff, or bootleg;
  - weapons (firearms, airsoft and BB guns, ammunition, switchblades, butterfly knives, brass
    knuckles, pepper spray, stun guns), tobacco, nicotine, vaping, and CBD, named in the title or
    description.

  The rest of the list can't be told from a listing. Mercari's own warning at List ("Oops!",
  its reason, "Continue listing") stops the step with Mercari's reason; Listora never continues
  past it. So does Mercari's notice that selling is restricted until the seller confirms their
  contact info.

## Structure

```text
mercari/
  adapter.ts       the scripts, on the AutomationAdapter base
  site.ts          Mercari's origin, paths, item ids, its challenge signs and private page parts
  payload.ts       the payload, validation, the SKU line
  prohibited.ts    the items Mercari prohibits that a listing shows
  categories.ts conditions.ts sizes.ts shipping.ts   the mapping tables
  catalog/         catalog.json (Mercari's categories and forms), its reader, its builder, and
                   the refresh script
  pages/           one module per page, with that page's selectors and flow:
                   account-page, listing-form (the sell and edit form), item-page, edit-page,
                   listings-page (the seller's tabs)
  fake/            the fake Mercari site, its conformance driver, its CLI
```

A page module throws `PageChangedError` when its page is not as it expects. The error message
names the page and what is missing, for example "Mercari's sell page has no listing form
(form[data-testid="ListingForm"]); the page may have changed.". The run records it as
`element_missing`:

- If it happens before anything was sent, the step falls back to the user's task.
- If it happens after the change was sent, the outcome is unknown, and a read-back decides.
- In a read, the read fails and is retried.

So a change to Mercari's site costs at most an assisted task. Fixing it means changing one page
module's selectors.

## Tests

The tests never send traffic to Mercari. They run in a real headless Chromium against the fake
Mercari site (`fake/fake-mercari.ts`). The fake copies the pages as Mercari serves them (read
on the seller's own session, 2026-10-26 and 27): the sell page drawn by its scripts, with the
templates tip, the category dialog over the whole catalog (with its `All <category>` rows), the
brand list with "No brand / Not sure", each category's size list, condition radios, the prepaid
label and the free-shipping question, and Smart Pricing on by default; the page after List or
Update with its link to the listing; the item page's data, with `stop` for a deactivated listing
and a 410 for a deleted one (with data for a sold one); the edit page drawn after load, with its
Deactivate and Activate toggle and Update; and the seller's tabs as tables whose rows draw a
moment after load. It can also inject each failure:

- Cloudflare's "Just a moment..." interstitial
- Cloudflare's Turnstile widget on a page
- a CAPTCHA
- a login-code step
- a logged-out session
- 429 and 5xx pages, and a 5xx that hides an applied change
- a form refusal, and Mercari's own refusals: an account to verify, a card to add, its warning
  that a listing may be a prohibited item
- a category whose form asks for an IMEI, and one the dialog no longer offers
- an answer that comes after the step's timeout
- a stale read
- a redesigned page

Two test files cover it:

- `adapter.conformance.int.test.ts` runs the shared adapter conformance suite.
- `adapter.int.test.ts` covers the Mercari flows and each check, and fills a form of every
  shape: each size group, and none.
- `categories.test.ts`, `sizes.test.ts`, `payload.test.ts`, and `catalog/catalog.test.ts` pin the
  mappings against the catalog.

Run the fake by hand with `npm run dev:fake-mercari` (`FAKE_MERCARI_SITE_URL`, see `.env.example`).
In development and tests, `FAKE_MERCARI_SITE_URL` points Mercari's adapter at the fake. Otherwise
`FAKE_AUTOMATION_SITE_URL`'s generic fake site stands in for Mercari. With neither set, the
adapter runs against Mercari itself.

## Live verification

Mapped and verified on the seller's own session (2026-10-26 and 27), on the Mac with Listora's own
phone runtime and scripts (`runPhoneCall` against the signed-in browser, in a background tab)
and from the iPhone, on Listora's own test listing:

- **List** (phone): the sell form, Smart Pricing switched off (it asked to confirm on the phone;
  on the Mac it switches off at once, and the script takes both), the add-a-card
  warning read as a refusal, and the page after List (`/sell/...` with "Sell another item" and a
  link to the listing). Posted in 49 seconds and confirmed by read-back.
- **Read** (Mac and phone): an active, a deactivated (`stop`), a sold (410 with data), and a
  deleted (410 without data) listing.
- **Change price** (Mac and phone, 23 seconds on the phone): the edit form draws seconds after
  the page loads (11 seconds once), and Update shows the same page as after List.
- **End and relist** (Mac): Deactivate and Activate act at once, with no confirmation, and open the
  seller's active listings.
- **Sale check** (Mac): the sold tab's rows show no sale time, only the day the row last changed
  ("Updated", `11/16/24`); the sale's time is the item page's `lastSoldAt`. On the iPhone, Mercari
  draws the tabs in its mobile layout, which it picks for a touch screen whatever the page's width
  (read 2026-10-28 on the seller's session: a 1280-pixel page with touch got it, one without did
  not). Its rows (`li[data-testid="ListItem"]`) link to their listing through the photo
  (`ProductThumbWrapper`) and the title (`RowItemWithMeta`) and show no `ItemLink` or price; the
  title and price come from the item page. While its query runs (about a second), it shows three
  placeholder `ListingRow`s that link to nothing, then the rows or `ZeroListings`; the desktop
  layout shows its table without rows instead. Reading those placeholders as rows failed every
  phone sale check from 2026-10-27 at "read the in progress sales".

**Full cycles on real items** (2026-10-27, Mac, phone runtime, normal pacing): five of the
seller's own items, each listed as a test listing, then List, its read-back with the listing's
URL, Change price, End, Relist, End again, and Delete (the edit page's Delete; the page then
answers 410 without data). Every step was confirmed by read-back, and the listing's own page
showed the category, size, brand, and condition Listora sent. Each test listing was deleted.

| Item                | Mercari category (form shape)         | Size       | List  | Price | End  | Relist | End   | Delete |
| ------------------- | ------------------------------------- | ---------- | ----- | ----- | ---- | ------ | ----- | ------ |
| Skinny jeans        | Women > Jeans (adult pants, by waist) | `23 in.`   | 35.9s | 9.5s  | 9.8s | 9.6s   | 8.7s  | 9.2s   |
| Ruffle-neck sweater | Women > Sweaters > Cardigan (women's) | `M (8-10)` | 39.0s | 7.7s  | 9.2s | 8.3s   | 7.3s  | 8.2s   |
| Maxi dress          | Women > Dresses, picked whole         | `M (8-10)` | 35.8s | 7.8s  | 7.5s | 8.5s   | 10.3s | 8.4s   |
| Long skirt          | Women > Skirts, picked whole          | `S (4-6)`  | 35.9s | 7.3s  | 7.7s | 8.1s   | 7.5s  | 9.3s   |
| Denim shorts        | Women > Shorts                        | `XS (0-2)` | 38.7s | 7.8s  | 7.0s | 7.0s   | 8.7s  | 9.2s   |

**Women's categories again, with today's scripts** (2026-10-27, evening, one Mercari session at
a time machine-wide, at least 10 minutes apart): a Ronni Nicole dress (`6`, filed as
`Women > Dresses > Knee-length`, `S (4-6)`, Like new), Abercrombie straight jeans (`27/4S`,
`Women > Jeans > Straight leg`, `27 in.`), Abercrombie shorts (`0`, `Women > Shorts > Short
shorts`, `XS (0-2)`), and a Wrangler denim maxi skirt (`S`, `Women > Skirts > Maxi`, `S (4-6)`),
each listed in 21 to 27 s and confirmed in 2 to 3 s, Change price 5 to 7 s, End, Relist, and End
again 3 to 4 s each, and deleted (gone for good). Twice that day List failed with Mercari's own
error under the List button (`ListingError`: "Your item could not be listed due to an error.
Please return to the Home screen and try listing the item again."), nothing listed. Listora read
it as a page it no longer understood after 45 seconds; it now ends the step as Mercari's error
(`server_error`), which is tried again once the listing is read back, and the next try listed it.

**Every form shape and department, filled but not listed** (2026-10-27): the seller's items are
all women's clothing, so the other shapes were checked by filling Listora's payload into the
live sell form and reading what the form showed, then closing it without listing: men's clothing
(`XXL (50-52)`), suits (`40R`), women's shoes (`8.5 (39)`), men's shoes (`10 (43)`), kids'
clothing (`3T`), kids' shoes (`2.5`), bras (`34E (DD)`), no size (Home, Beauty), and a category of
each of the other 10 departments. Each showed the category, size, and brand Listora picked. A
phone (`Electronics > Cell phones & accessories > Cell phones & smartphones`) showed the IMEI
field, and is refused before anything is sent. Found on the way, and fixed: Mercari fills a
brand and a category from the photos (a brand it suggests is kept; the category is picked
again), Smart Pricing switches off without a confirmation on the Mac, the brand list can take a
few seconds to load, and the size list can miss a tap while the form redraws. The women's size list
(read again 2026-10-27, nothing listed) heads its parts Standard, Petite, Maternity, and Tall, and
labels each option with its part (`aria-label="Petite S (4-6)"`), which is how a petite size is
picked.

When the live site differs, the step stops before it sends anything and the user does it, so a
change can never cause a false success. The run logs what the page has instead
([automation.md](automation.md#how-it-works), "When a page changes"). Fixing a mismatch means
changing the selectors in one page module.
