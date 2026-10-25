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

| Operation  | How                                                                                                 | Confirmed by                                     |
| ---------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Create     | Fills the sell form (`/sell/`), then clicks List. Only that click can change anything.              | The listing page: status, title, text, price     |
| Revise     | Fills the edit form (`/sell/edit/<id>/`) with every detail except photos, then clicks Save          | The same                                         |
| Price      | Fills only the price on the edit form, then clicks Save                                             | The same                                         |
| End        | **Deactivate** on the edit page, then confirms in its dialog. The listing is kept, never deleted.   | The page shows the listing as inactive (`ended`) |
| Relist     | **Activate** on the edit page of an inactive listing. The listing keeps its id.                     | The page shows the listing for sale (`active`)   |
| Mark sold  | Not needed: Mercari marks its own sales sold                                                        |                                                  |
| Read       | The listing's page (`/us/item/<id>/`)                                                               |                                                  |
| Sale check | The seller's "in progress" (sold, waiting to ship) and "sold" tabs, newest first                    |                                                  |
| Listings   | The seller's "active" and "inactive" tabs, all pages (`listListings`, for imports and drift checks) |                                                  |
| Health     | The account page (`/mypage/`)                                                                       |                                                  |

- A sold listing cannot be edited or relisted. Listora refuses those steps and tells the user
  to list the item again.
- A sale check reports each sold item as one order. Its id is the item id, because a Mercari
  listing sells only once.

**Freshness.** The listing page's last-updated time (`time[datetime]`) is the listing's revision,
in milliseconds. Mercari changes it with every edit. Automated changes are always seconds apart
because of pacing, so the revision grows with every change. A stale page shows an older time, and
the engine ignores it ([operations.md](operations.md)).

**Absence.** Only Mercari's own "this item has been deleted" notice for an id is a definitive
absence. A plain "not found" page could be a listing that is not visible yet, so it never counts.

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
Mercari site (`fake/fake-mercari.ts`). The fake copies the adapter's model of Mercari: the same
paths and page elements, the sell form's level-by-level category picker, brand search, size
lists and validation, the edit page's confirmation dialogs, and the seller's tabs with
pagination. It can also inject each failure:

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

Mercari's logged-in pages sit behind Cloudflare bot protection, which Listora never gets around.
So the paths and selectors in `site.ts` and `pages/` are Listora's model of Mercari's US site, and
they were not checked against the live site while building this. The first linked session should
confirm them, ideally with the product owner watching. Check each of these in order:

1. The account page path, and its marker element.
2. On the sell form:
   - the photo input
   - the title and description fields
   - the category levels and their names in `categories.ts`
   - the brand search and its suggestions
   - the condition values 1 to 5
   - the size lists
   - the shipping choices and weight labels
   - the price field
   - the List button
   - the validation message
3. On the listing page: its path and id format, name, price, description, last-updated time,
   sold badge, inactive notice, and deleted notice.
4. On the edit page: its path, the Deactivate and Activate buttons, and their confirmation
   dialog.
5. On the seller's tabs: their paths and pagination, the row link, title, price, and sold time.
6. The limits in `MERCARI_LIMITS`.

When the live site differs, the step stops before it sends anything and the user does it, so
this check can never cause a false success. Fixing a mismatch means changing the selectors in one
page module.
