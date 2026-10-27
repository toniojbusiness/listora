# Marketplace pre-fill

The review fills in each marketplace's own sell form for the item, so listing needs no
marketplace picking in the normal case: Depop's, Poshmark's, and Mercari's category in their own
trees, the size from that category's own list, and the condition, brand, colours, and material
their forms show. An in-between item (a unisex tee) gets the marketplace's own convention as a
pre-selected choice the seller can change. Only when Listora's mapping can't settle a field, and
the cheap AI isn't sure either, does the review ask, as one tap on a ranked short list, before the
seller lists. So a listing never stops on "Action needed" for something the review could have
asked. eBay's categories come from its own taxonomy ([ebay.md](ebay.md)) and are not part of this.

| Where                                                                      | What                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/automation/src/prefill/`                                         | The pure pre-fill: `prefillItem`, one module per marketplace, the ranker |
| `packages/analysis/src/marketplace-prefill.ts`                             | The AI's pick among a question's options (`pickPrefillOptions`)          |
| `apps/api/src/prefill/`                                                    | The two endpoints, the stored answers and picks, the AI step             |
| `apps/api/src/listings/actions.ts`                                         | The List flow's categories and new listings follow the pre-fill          |
| `ReviewFeature` (`MarketplacePrefillView`, `ReviewFlowModel+Marketplaces`) | The review's "On each marketplace's form" section                        |

## How it works

`prefillItem` (pure, free) reads the item's analyzed details and each marketplace's versioned data,
the same files and mapping tables its payload builder uses: Depop's taxonomy
([depop-automation.md](depop-automation.md#the-taxonomy), 281 product types), Poshmark's catalog
([poshmark.md](poshmark.md#mapping-tables), 6 departments, 114 categories, 633 subcategories), and
Mercari's catalog ([mercari.md](mercari.md#the-catalog), 3,233 categories, 9 size lists). Each
field gets a value, a ranked short list (at most 4, the value first), where the value came from,
and whether it is a question:

| Source    | Meaning                                                                                    |
| --------- | ------------------------------------------------------------------------------------------ |
| `listora` | Listora's mapping onto the marketplace's real tree or form                                 |
| `default` | The marketplace's convention for an in-between item; shown as a chip the seller can change |
| `ai`      | The AI picked it from the short list, with confidence 0.7 or more                          |
| `you`     | The seller tapped it                                                                       |

What the review shows is exactly what the form gets: a test builds every marketplace's payload
from the pre-fill, for every canonical category in every department, and checks the category and
size match (`prefill.test.ts`).

- **Category.** The marketplace's mapping table, then refined into the subcategory the item's own
  name says (`Women > Jeans` becomes Mercari's `Skinny Jeans` and Poshmark's `Skinny` for "skinny
  jeans"; `Women > Dresses` becomes `Maxi` for a maxi dress). Every word of the subcategory that
  its parent doesn't have must be in the title, product name, or keywords, and only one
  subcategory may match, so a refinement is never a guess (a ruffle neck is no `V-neck`, and
  "shorts" says no more than `Shorts`). A name with alternatives is matched by any one of them:
  Mercari's `Above knee, mini` for a mini dress, `Straight, pencil` for a pencil skirt.
- **In-between items.** A unisex item goes under Men on Depop (it has no unisex department),
  Poshmark (whose men's sizes fit), and Mercari (except the kinds Mercari keeps under Women), with
  the Women category as the other chip.
- **Girls or boys.** Mercari's Kids tree and Poshmark's Girls and Boys size sets file kids' clothes
  apart; Depop's web form doesn't. When the kind doesn't say (a dress is a girls' item) and the
  item's words don't ("girls'", "boy"), it is one question for the item (`kids_gender`), and every
  marketplace's category and size follow the answer.
- **Nothing to go on.** For an item whose canonical category says nothing (`other`), or a kind a
  marketplace has no place for in its department (a men's dress on Depop), the candidates are the
  marketplace categories the item's words match best, the kind's category in the other department,
  and every top-level kind of the tree it could be (each refined by the item's words: Mercari's
  `Home > Home decor > Home Decor Lamps` for a lamp), so the AI can place what the words don't
  name. A phone category whose Mercari form asks for an IMEI is never offered.
- **Size.** The size list of the chosen category, read the way the payload reads the tag. A tag no
  list has (a UK 10) is a question, closest sizes first, with every size behind "More"; the AI can
  read a standard conversion (a UK women's 10 is a US 6). Without a tag size nothing is guessed.
- **The rest.** The marketplace's condition label, the brand (Mercari's "No brand / Not sure" for
  none), Depop's and Poshmark's colours, and Depop's material where its form has one, as their
  forms show them. They follow the item's details, which the review edits above.

### The AI, cheap and once

The questions Listora's mapping can't settle go to the AI in one call of the standard tier
(Claude Haiku 5.5, text only, no images, purpose `marketplace_prefill`, no plan quota), through
`AiClient`, so the kill switch, the account block, and the daily budget apply and every call is
metered ([ai.md](ai.md)). The model only picks an option's number from each list, or none, with its
confidence; strict structured output holds it to that. A pick at 0.7 or more is the value;
below, it leads the seller's short list. Each question is asked once: its pick (or "none") is
stored by a hash of the item's details and the list it chose from, so reading the pre-fill again
costs nothing, and a question changes only when its list does. A normal clothing item asks
nothing and costs nothing.

- AI switched off, the account blocked, or the budget used up: the questions are asked of the
  seller, and the AI is tried again on a later read.
- A billed call that failed: its questions go to the seller and are not paid for again. A call
  that was never billed (aborted after 10 seconds, overloaded) is tried again on the next read.
- The review only asks the AI about the marketplaces the seller lists on through Listora (an API
  connection or a linked session); the List flow asks about the one it lists on.

### Answers

The seller's tap is stored with the item details it was given for (`basis`: a hash of the
category, department, and size). Once one of them changes, the answer no longer holds and the
question is asked again. The server takes an answer only when the marketplace offers it
(`422 validation_failed` otherwise): any category of the marketplace's tree, a size of the
category's list, or girls or boys.

### Listing with it

- **The List flow** reads the marketplace's categories (`getItemMarketplaceCategories`): its
  `suggested` is the pre-fill's category, and while that is a question, `likely` is its ranked
  short list, which the List flow shows as one-tap rows, every category behind "More categories".
  So the List flow never shows a blank picker. Bulk "List all" skips an item only while it still
  has a question.
- **A new listing** (`createListing`, `replaceListingDraft`) without a `categoryRef` gets the
  pre-fill's category when it differs from the payload's own mapping (the seller's tap, the AI's
  pick, a refined subcategory), and a `Size` aspect with the marketplace's size when the
  payload's own reading of the tag would not give it. Only stored answers and picks are read;
  nothing calls the AI there.
- **The payloads** read the tag's size as before; for a tag size the category's list doesn't have,
  Depop's and Mercari's take a `Size` aspect that is one of the list's own labels (Poshmark's aspect
  already wins, read as Poshmark's own size), so the form gets exactly the size the review showed.
  A tag size the list has is the size on every marketplace; the seller changes it on the item.

## The review (iPhone)

`ReviewFeature` shows "On each marketplace's form" for the marketplaces Listora lists on itself:
per marketplace its category path (with the unisex Men or Women chip), its size, and one line with
the condition, brand, colours, and material, and "Ready" or how many to pick. A question is a card
in the warning tint with its short list as chips, the AI's guess first, and "More" for every
category (searchable) or size; girls or boys is one card above the marketplaces. While there is a
question the section sits right after "Check these", and Continue waits for the tap ("Pick the
marketplace detail above to continue."). The pre-fill is read when the review opens and again
after each edit of a detail it reads (category, department, size, size type, brand, condition,
colours, materials), with the review's unsaved values (`PrefillDetails`), so it always matches
the screen. A read that fails leaves the review as it is: the List flow checks again before it
lists.

## Live check (read-only, 2026-10-27)

On the captain's real inventory, with no posting and no database: Listora's three items, the
seller's 11 real Mercari listings (with the category the seller chose there), and 7 kinds the
inventory has none of yet, with the real Haiku 5.5. 21 items, 7 AI calls, **$0.00335 in all:
$0.00016 per item on average, $0.0005 for an item that needed the AI, $0 for the 14 clothing
items, which asked nothing.**

| Item                                 | Listora's pre-fill                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| Comfort Colors and Shaka Wear tees   | Men > Tops > T-shirts everywhere (default, Women as the chip), sizes from each list    |
| PSD boxer briefs                     | Depop Boxers and briefs, Poshmark Boxer Briefs, Mercari Men > Other (no underwear)     |
| Skinny jeans, straight-leg jeans     | Mercari's `Skinny Jeans` and `Straight leg`: the seller's own picks                    |
| Maxi dress, long (maxi) skirt        | Mercari's `Dresses > Maxi` and `Skirts > Maxi`: the seller's own picks                 |
| Four more dresses, a sweater, shorts | The seller's category or its parent (`Women > Dresses` for a knee-length dress)        |
| LEGO set                             | AI: Depop Building sets and blocks, Poshmark Building Sets & Blocks, Mercari LEGO Toys |
| Brass table lamp                     | AI: Depop Home accessories, Poshmark Home > Other, Mercari Home Decor Lamps            |
| Frozen Elsa nightgown                | AI: girls; then Mercari Girls other (4+), Poshmark 6 (Girls)                           |
| Kids dinosaur tee, size 8            | AI not sure: one question, girls or boys                                               |
| UK 10 blouse                         | AI: US 6 on Depop and Poshmark, S (4-6) on Mercari                                     |
| Men's floral dress                   | AI not sure on Depop and Poshmark: Women > Dresses first in the short list             |
| Nintendo Switch game                 | AI: Poshmark and Mercari video games; Depop asked (Depop prohibits most tech)          |

Of the 11 Mercari listings, Listora's category was the seller's own for 4 and its parent for 4;
the other 3 the seller filed differently (two dresses under Blouse, an athletic dress under
Athletic apparel), where Listora's `Women > Dresses` is a category Mercari offers for them. Found
and fixed on the way: a refinement on a word the item never said (`V-neck` for a ruffle neck) or
that said no more than its parent (`Short shorts`), and a lamp no word placed.

## Local development

With `AI_PROVIDER=fake`, the fake provider answers the AI's question from a fixture's
`marketplace_prefill` output (`{"picks": [{"question": "mercari.category", "option": 2,
"confidence": 0.9}]}`, an option's number on the list); a fixture without one fails as
`fixture_missing`, which is never billed, so the questions are asked of the seller. The e2e stack's
test user links no automated marketplace, so the review shows no pre-fill there.

## Data

- `item_prefill_answer`: the seller's answers, one per item and key (`kids_gender`,
  `<marketplace>.category`, `<marketplace>.size`), with the `basis` they hold for.
- `item_prefill_pick`: the AI's pick per question (`decision_hash`), or none, so each question is
  paid for once.

Both go with their item.

## Not yet

- eBay's category and item specifics (eBay's taxonomy is its own).
- Depop's item specifics (body fit, length, fit, type, style) are filled when the listing is
  posted ([depop-automation.md](depop-automation.md)) but not shown on the review yet; its
  occasion, source, and age are left for the seller.
- A dress's length (`Above knee, mini`, `Knee-length`) from its description rather than its name.
