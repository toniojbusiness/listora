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

| Operation  | How                                                                                                           | Confirmed by                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Create     | Fills the sell form (`/sell/`), then clicks List. Only that click can change anything.                        | The listing page: status, title, text, price     |
| Revise     | Fills the edit form (`/sell/edit/<id>/`) with every detail except photos, then clicks Update                  | The same                                         |
| Price      | Fills only the price on the edit form, then clicks Update                                                     | The same                                         |
| End        | **Deactivate** on the edit page (it acts at once, with no confirmation). The listing is kept, never deleted.  | The page shows the listing as inactive (`ended`) |
| Relist     | **Activate** on the edit page of an inactive listing (same id); a listing Mercari removed is posted anew.     | The page shows the listing for sale (`active`)   |
| Mark sold  | Not needed: Mercari marks its own sales sold                                                                  |                                                  |
| Read       | The listing's page (`/us/item/<id>/`)                                                                         |                                                  |
| Sale check | The seller's "in progress" (sold, waiting to ship) and "sold" tabs, newest first                              |                                                  |
| Listings   | The seller's "active" and "inactive" tabs, up to 25 pages each (`listListings`, for imports and drift checks) |                                                  |
| Health     | The account page (`/mypage/`)                                                                                 |                                                  |

- A sold listing cannot be edited or relisted. Listora refuses those steps and tells the user
  to list the item again.
- `listListings` reports the title, price, and status each tab shows. The tabs show no
  description or last-updated time, so those are `null`, and a listing found this way never
  confirms an operation. It reports `complete: false` when a tab has more than 25 pages.
- A sale check reports each sold item as one order. Its id is the item id, because a Mercari
  listing sells only once.

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
- A create's second or later attempt looks the same way first. If it finds the listing, it
  reports that listing and lists nothing.

The SKU is the listing's `external_sku`, or else its Listora listing id. Nothing sets
`external_sku` yet, so for now the line shows the listing id (a follow-up in the PR). The line
counts against Mercari's 1,000-character description limit. Validation keeps 71 characters free
for it, so a description can be at most 929 characters.

## Mapping Listora's details to Mercari's

The mappings are static tables in the repository. Each has a test.

- **Category** (`categories.ts`): maps the canonical category and the department (men or women)
  to Mercari's category levels, for example `clothing/tops/t_shirts` for women becomes
  `Women > Tops & blouses > T-shirts`. The most specific entry wins. Kids', unisex, home, and
  other items have no mapping. Validation then asks for a category, which the listing can name
  itself in `variant.categoryRef` as Mercari's names joined with `>`.
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

- **Size** (`sizes.ts`): the category says which size list applies (clothing, shoes, or none).
  The script picks the option whose label is the size, or starts with the size and a space
  (`M (8-10)`). Some examples:
  - `Small` becomes `S`, and `2XL` becomes `XXL`.
  - Numeric sizes stay as they are.
  - Waist and inseam (`W32 L30`) becomes the waist, `32`.
  - US shoe sizes come in halves (`10 1/2` becomes `10.5`).
  - UK and EU shoe sizes are not mapped.

  Clothing and shoes need a size that maps; validation asks for one otherwise.

- **Brand**: the script types the brand into Mercari's brand search and picks the suggestion that
  matches exactly, ignoring case. The form takes only brands from Mercari's list. When no
  suggestion matches, the listing is posted without a brand.
- **Shipping** (`shipping.ts`): Mercari's prepaid label, paid by the buyer. The package weight
  comes from the item's category, for example `Up to 8 oz` for T-shirts and `Up to 5 lb` for
  boots. Listora does not know an item's weight yet, so each category's weight is a generous upper
  bound. A label that is too light gets adjusted and charged to the seller, while one that is too
  heavy only costs the buyer a little more.
- **Limits** (`payload.ts`):
  - titles: 80 characters
  - descriptions: 1,000 characters, including the SKU line
  - prices: whole dollars, from $1 to $2,000
  - photos: 1 to 12, uploaded in posting order
- **Prohibited items**: Mercari's prohibited items include "items that are soiled with human
  materials such as used underwear" (read 2026-10-27), so used underwear (a pre-owned item whose
  own category is underwear) is refused before anything is sent. New underwear goes to Men or
  Women > Other, whose form asks no size.

## Structure

```text
mercari/
  adapter.ts       the scripts, on the AutomationAdapter base
  site.ts          Mercari's origin, paths, item ids, its challenge signs and private page parts
  payload.ts       the payload, validation, the SKU line
  categories.ts conditions.ts sizes.ts shipping.ts   the mapping tables
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
templates tip, the category dialog, brand and size option lists, condition radios, the prepaid
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
- a form refusal
- an answer that comes after the step's timeout
- a stale read
- a redesigned page

Two test files cover it:

- `adapter.conformance.int.test.ts` runs the shared adapter conformance suite.
- `adapter.int.test.ts` covers the Mercari flows and each check.

Run the fake by hand with `npm run dev:fake-mercari` (`FAKE_MERCARI_SITE_URL`, see `.env.example`).
In development and tests, `FAKE_MERCARI_SITE_URL` points Mercari's adapter at the fake. Otherwise
`FAKE_AUTOMATION_SITE_URL`'s generic fake site stands in for Mercari. With neither set, the
adapter runs against Mercari itself.

## Live verification

Mapped and verified on the seller's own session (2026-10-26 and 27), on the Mac with Listora's own
phone runtime and scripts (`runPhoneCall` against the signed-in browser, in a background tab)
and from the iPhone, on Listora's own test listing:

- **List** (phone): the sell form, Smart Pricing switched off (it asks to confirm), the add-a-card
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
  draws the tabs in its mobile layout, whose rows link to their listing only through the photo
  (`ProductThumbWrapper`) and show no title or price; those come from the item page.

When the live site differs, the step stops before it sends anything and the user does it, so a
change can never cause a false success. The run logs what the page has instead
([automation.md](automation.md#how-it-works), "When a page changes"). Fixing a mismatch means
changing the selectors in one page module.
