# Importing existing listings

A seller who already sells on Depop, Poshmark, or Mercari brings those listings into Listora in
one tap: each listing for sale becomes an inventory item that is already listed there (photos,
title, description, price, category, size, brand, condition, and the listing's id and URL), the
same item listed on several marketplaces becomes one item with several listings, and **List on
the others** then crosslists it to the marketplaces it is not on yet, through the normal List
flow. Listora only reads the marketplace: an import never changes or ends a listing. Sold
listings come in another way: each sale the marketplace's sale checks find becomes a sale, of a
sold item made the same way when Listora had no listing for it ([sales.md](sales.md#sales-history)).

| Where                                                            | What                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/automation/src/<marketplace>/scripts.ts` (`listings`)  | One page of the seller's listings for sale, each with its details     |
| `packages/automation/src/<marketplace>/pages/listing-details.ts` | What each marketplace's data says of a listing's photos and details   |
| `packages/automation/src/imports/`                               | Reading the pages where the connection runs, keeping what each showed |
| `packages/automation/src/categories.ts` (`importedCategory`)     | A marketplace category in Listora's canonical vocabulary              |
| `packages/imports`                                               | Starting an import, settling each listing, the match, photos, answers |
| `apps/api/src/imports/`                                          | The import endpoints                                                  |
| `apps/worker/src/features/listing-imports.ts`                    | The worker's `listing_import_apply` job                               |
| `ImportFeature` (iOS)                                            | Settings > Import your listings, and the questions screen             |

Imports are offered only from marketplaces whose imports passed live (Depop and Mercari today,
[verified-features.md](verified-features.md)). Starting one elsewhere is refused.

## How it works

1. **Starting** (`startListingImport`, `POST /v1/imports`): only on a marketplace linked by
   signing in (an automation connection that works), one import at a time per marketplace.
   eBay is not offered yet: Seller Hub's rows carry no photos or details.
2. **Reading** (automation `imports/`): one page per browser session, where the connection runs:
   on the seller's iPhone as `listing_import` phone work (behind routine changes, with the pause
   between sessions and the per-seller rate limits like any run), or in the cloud as the browser
   runner's `automation_listing_import` task. Each page is the marketplace's own list of the
   seller's listings for sale, read the way its pages read it:
   - **Depop**: the selling hub's list from Depop's web API (24 a page), then each listing's own
     edit data (`edit-listing`) for its photos, brand, condition, category, colours, and pricing.
     The category is Depop's ids (`gender` or `is_kids`, `group`, `product_type`, as
     `womenswear/bottoms/jeans`), which the server reads against Depop's taxonomy: the names in
     `categories` often stop at two levels (Womenswear > Bottoms) or use names the sell form no
     longer offers (Lingerie, Vests), so they name it only without the ids. The brand is `brand_name` ("Hollister Co."), not Depop's slug of it,
     and Depop's "Other" is no brand. A marked-down listing keeps its `original_price` beside
     the price a buyer pays now. Its listings have no title, so the item's title is the first
     line of its text.
   - **Poshmark**: the seller's closet (48 a page, `availability=available`), whose records carry
     the cover photo and the others, brand, size, condition code, and department, category, and
     subcategory.
   - **Mercari**: the active listings tab, then each listing's page, whose data (an Apollo cache:
     `ItemDetail` and the records its `__ref`s name) holds its photos, brand, size, condition,
     and category path (read on the captain's account, 2026-10-27).
     Every read is a GET; nothing is typed or submitted. A page's listings are kept as the import's
     entries (each listing once), the worker is asked to settle them, and the next page is asked
     for until the marketplace has no more (at most 100 pages).
3. **Stopping.** A page that could not be read ends the reading with the reason in the seller's
   words (`stoppedReason`): a check the seller is not there to complete ("Depop wants you to
   complete a check in Listora on your iPhone. Import again once it's done to read the rest."),
   a sign-in the seller declined (the connection then waits for a relink, as for any run), a page
   Listora no longer reads. Listora never passes or works around a check. The listings read
   before it still import, and importing again reads from the start: listings already imported
   settle at once. A page's listings that Listora already has (by their marketplace id, from a
   linked shop) are not read on their own pages: the call names them (`held`), and Depop and
   Mercari take them from the list as it shows them (`fromList`), since they settle as
   `already_listed` by their id. So a re-import of a 118-listing Depop shop reads its 5 pages and
   only the listings that are new, instead of 123 reads. A listing of a shop that was unlinked is
   read in full, since settling it joins it to the new shop.
4. **Settling** (`@listora/imports` `applyListingImport`, after every page): each entry becomes
   - `already_listed`: Listora already has this listing (its marketplace id); one from an
     unlinked shop joins the import's connection again, since this shop shows it
     ([marketplace-linking.md](marketplace-linking.md#relinking-another-shop));
   - `merged`: a listing of the item it is the same as; the item keeps its own details and photos;
   - `imported`: a new item, with the listing's photos;
   - `needs_you`: a question for the seller (below);
   - `failed`: its photos could not be fetched ("Import again to try again"), or it was read
     from the list as one Listora had and its item was deleted before it settled ("Import again
     to bring it back"): the list's record has too little to import it from.
     An imported or merged listing is `active` on its marketplace as the import read it: that read
     through the seller's session is its read-back (`last_verified_at`, `remote_snapshot`,
     `remote_revision`), so it shows as "Active (confirmed by Depop)" and its item is `listed`
     (`syncItemListedStatus`). From then on it is an ordinary listing: price changes, ends, and
     relists go through the operation engine.
5. **The match** (`match.ts`, pure). Candidates are the account's items that are not sold or
   archived and have no live listing on that marketplace yet.
   - By the **SKU line**: a listing whose text ends with Listora's `SKU: AJ-000184` names the
     item with that SKU, or the item another listing with that line belongs to.
   - By **title and photos**: titles alike (the share of telling words they have in common) and
     photos alike (the closest pair's perceptual-hash distance, 64 bits). It is the same item
     only when both say so (the same photo and a close title, or a nearly identical title and
     photos that look alike) and the brands don't differ, for exactly one item.
   - **Ask when unsure**: two such items, or one that only the photo or only the title points to,
     become a question with the closest three, best first. Nothing is merged below that bar.
     Every entry is settled under the account's import lock, so imports of two marketplaces at once
     never make two items of one item.
6. **Photos** (`photos.ts`): the server fetches each listing photo from the marketplace's own
   image CDN, https only (plain http only from a local fake marketplace in development), from a
   host with public addresses only, resolved once and connected to at the address that passed (so
   a DNS answer that changes in between cannot reach a private address; the certificate is still
   checked against the host), no redirects, an image type, at most 15 MB (the read stops there),
   at most 4096 x 4096 pixels, at most 16 per listing; a PNG or WebP becomes a JPEG. Each is stored as an upload and processed by the photo
   pipeline like any other (derivatives, metadata stripped, the upload deleted); its perceptual
   hash is computed first for the match.
7. **The item's details** (`details.ts`): the title (Depop: the first line without the hashtags
   on it, within 80 characters), the description without Listora's SKU line (and Depop's
   hashtags), the brand, the size and its system, the colours (Depop's, in Listora's terms), the
   condition in Listora's terms, never claiming more than the listing (Poshmark's "Like New" and
   Mercari's "Like new" are pre-owned excellent, Depop's "Brand new" is new without tags), the
   price (the item's list price is the price before a markdown, so it never lists elsewhere at
   a sale price; the listing keeps the price it shows now), and Listora's canonical category
   and department from the
   marketplace's category (`importedCategory`: the canonical category whose mapping onto that
   marketplace lands closest to it, so List on the others places it through the same maps and
   pre-fill as any item). Each detail it set has the provenance `marketplace`.

## Questions

`listListingImportQuestions` lists an import's open questions: the listing (its title, price,
cover photo on the marketplace's CDN, and link) and each item it may be, with why ("A photo looks
the same"). `answerListingImportQuestion` takes `same_item` (one of the candidates: the listing
becomes that item's listing there), `new_item` (the worker imports it as an item of its own, with
its photos, and matches it no more), or `skip`.

## In the app

Settings > **Import your listings** (`ImportFeature`): each of Depop, Poshmark, and Mercari with
why an import can't start (not linked, one under way), its newest import in the server's words
("Reading your Depop listings on your iPhone... 48 so far", "Importing 12 of 42", then "Imported
42 from Depop, 3 need you"), why it stopped early, and **Answer 3 questions**. Starting runs this
phone's waiting work at once; the screen reads again every few seconds while an import runs and
whenever the phone finishes a run. On the item screen, **List on the others** opens the List sheet
for the marketplaces the item is not on yet ([inventory.md](inventory.md)).

## Local development

Nothing to configure. The fake Depop, Poshmark, and Mercari sites list a seller's listings with
their photos on their own image CDN (`/media/<name>.jpg`, a distinct real JPEG per name,
`fake-photos.ts`), and the worker fetches photos over plain http from them when a fake
marketplace is configured.

## Tests

- Each marketplace's `listings` read against its fake site (`<marketplace>/adapter.int.test.ts`),
  read-only; on Depop and Mercari, only the listings Listora doesn't have read on their own
  pages. On Mercari's recorded active tab, holding every listing reads none of their pages
  (`recordings/recordings.int.test.ts`).
- The phone: an import's pages read one session each, read-only, the call naming the listings
  Listora has so their own pages are not read, and a check or a declined sign-in stopping it with
  the reason (`phone/work.int.test.ts`).
- Settling (`packages/imports/src/apply.int.test.ts`): new items with photos and details listed
  there, merges by SKU line and by title and photos across marketplaces, questions and their
  answers, listings Listora already has (read in full or from the list), one read from the list
  that Listora no longer has, photos that can't be fetched, and two imports at once.
- The match, the details and category mapping (with the categories of the captain's own Mercari
  listings), and the API (`apps/api/src/imports/imports.int.test.ts`).
- The app: `ImportFeatureTests` and `ListOnTheOthersTests`.

## Live verification (2026-10-27)

Read-only, in the captain's signed-in Chrome sessions on the Mac, background tabs, gentle pacing:

- **Mercari**: Listora's own import read, through the phone runtime, read the 11 listings for
  sale with every one's photos (`u-mercari-images.mercdn.net`, which the server fetched),
  brand, size, condition, and category.
- **Poshmark**: Listora's import read ran to its end on the captain's closet, which has no
  listings for sale; the record shape (photos, brand, size, condition, catalog) was read on a
  public category page.
- **Depop**: both sessions met a human check on the selling hub (Cloudflare "Just a moment..."
  and a bot check), and stopped there as they must. A later read-only scout of a real shop
  (2026-10-28, 118 listings) gave the `edit-listing` keys the import now reads (category ids,
  `brand_name`, `colour`, and `pricing` with a markdown); the fake Depop models them, and every
  one is still read leniently.

## Data

Migration `20261027194404_listing_imports`:

- `listing_import`: one import per connection at a time: status (`reading`, `importing`,
  `finished`), where it reads (`host`), the next page's cursor, pages and listings read, the
  counts of each outcome, and why reading stopped early. Deleted with its connection or account.
- `listing_import_entry`: each listing an import read (`listing`, a `ListedListing`), its outcome,
  how a merge found its item (`sku`, `title_photos`, `seller`), the item and listing it went to,
  a question's candidates, a failure's message, and whether the seller said it is an item of its
  own (`new_item`).
- `phone_work.purpose` gains `listing_import`, one per connection, with its `import_id`;
  `automation_run.purpose` gains `import`.

## Open items

- eBay imports, once eBay's API (or Seller Hub's listing pages) gives photos and details.
- Depop's live keys, once a session gets past Depop's check (see above).
- Poshmark's private SKU is only on its edit form, so Poshmark matches by a SKU line in the text,
  never by the private SKU.
- Server-side photo fetching from the cloud is not yet proven against each marketplace's CDN in
  AWS (Mercari's was fetched from the Mac).
- `listing_import_entry` keeps each listing's read until the import is deleted; a retention rule
  can follow.
