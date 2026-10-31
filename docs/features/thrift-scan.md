# Thrift scan: the household's own sales for sourcing

The thrift scan helps the seller decide at the store whether an item is worth buying. It is
built in milestones, each shipped and live-tested on its own. This file covers what is built so
far: **own-history comparisons** (milestone M1), the household's own sales as the first source of
real sold data (`own_history`). The scan itself, comparisons from other sellers' listings,
thrift runs, and offline reads come in later milestones.

Code: `packages/sourcing` (`@listora/sourcing`, pure rules: the brand and size keys, the price
range, which sales are similar, the kit's groups), `apps/api/src/sourcing` (the sales that count,
the kit's route, the price screen's own history), and `getItemPricing`
([pricing.md](pricing.md)), which shows it. Nothing here calls a marketplace or AI: every number
comes from the sales Listora already recorded ([sales.md](sales.md#sales-history)).

## The sales that count

Only real sales count, and only ones the seller is shown:

- **Standing.** The sale is detected, confirmed, or shipped; canceled and returned sales never
  count.
- **Recent.** It sold in the last 365 days (`OWN_HISTORY_WINDOW_DAYS`); older prices say little
  about today's.
- **Read by a feature that passed live.** The sale is on a marketplace whose `sales_history` is
  on for the account (`ownSalesMarketplaces`, [verified-features.md](verified-features.md)): for
  sellers today Depop and Mercari, and every marketplace in the owner's Test mode. A sale an
  unproven read recorded is never shown as the seller's history. This also leaves out a
  marketplace's sales the seller marked sold by hand until its sales history passes live.
- **Of an item with a brand.** A bundle's items each count, at what the buyer paid for each.

**eBay is display only.** The seller's own eBay sales are shown as their own sales, but nothing
models a price or a call from them, for the eBay licence reason that keeps eBay fee data out of
floors (red flag RF3, `OWN_SALES_MAY_MODEL_PRICES` in `@listora/pricing`). Marketplaces are
always listed in the fixed `KnownMarketplace` order, never ranked
([profit.md](profit.md#marketplaces-side-by-side-never-ranked)), and no days to sell are shown.

## Similar items and their range

- **Similar** (`isSimilarSale`): the same brand, compared by its key (without case, accents,
  spaces, or punctuation: "Levi's" and "LEVI’S" are `levis`), and the same canonical category when
  the item has one. An item without a brand has no similar sales: brand moves a resale price
  most, and without it a match is noise. The item's own sale never counts.
- **The range** (`priceStats`): the lower quartile, the median, and the upper quartile of what
  buyers paid, never a single price. The quartiles are nearest-rank, so each is a price a buyer
  really paid, and one outlier moves neither.

## On the item's price screen

`getItemPricing` computes the item's own history on every read and adds one `own_history`
sold comparable per marketplace with at least two similar sales (`MIN_OWN_HISTORY_SALES`: one
sale is a price, not a range), labeled "Your sales of similar Lululemon items on Depop (last 365
days)". The comparable names no `marketplace`: that field means data bound to one listing's
context (Depop Pricing Inspiration), and the seller's own sales are not, so the price screen
shows them under "Where the prices come from" ("3 sold, $22.00 to $30.00, median $28.00"). With
any, the "No sold data available" message is gone. Like all sold data, it never sets a tier.

Own history is never stored as a `pricing_snapshot`: it is always computed from the sales, so it
is current the moment a sale is recorded or canceled, and a stored `own_history` row is ignored.

**No new app build is needed**: the app already shows sold comparables without a marketplace,
with their label.

## The sourcing kit

`getSourcingKit` (`GET /v1/sourcing/kit`) is the same sales, grouped for looking a brand up at
the store with no signal (the offline read comes in a later milestone; the app does not read the
kit yet).

- **Groups** (`buildSourcingKit`): every brand, then each of its categories, then each size in a
  category (the size compared without case or spaces, letter sizes spelled short: "Medium" is
  `m`). Each group with a sale is listed, so a group missing from the kit has none. The brand is
  spelled as most of its sales spell it.
- **Per group:** the sales per marketplace (count, the range, the median payout after that
  marketplace's fees from its current fee table, an estimate, with the table's version), whether
  they are display only (eBay), and how many of the account's items of the group sit unsold
  (ready or listed).
- **Size:** at most 2,000 groups (`MAX_KIT_BUCKETS`); past that, size groups go first, then
  category groups, the ones with the fewest sales first. The kit has a format `version` (1); a
  client that does not know it ignores the kit.

## Tests

- `packages/sourcing`: the keys, the range, similar sales, and the kit's groups, order, eBay
  flag, and limit, on invented sales.
- `apps/api/src/sourcing/sourcing.int.test.ts`: the price screen's own history per marketplace
  (canceled, old, other-category, and other accounts' sales left out; the item's own sale left
  out; two sales needed; no brand, no history), the gate for a seller and in Test mode, and the
  kit, empty without sales, gated the same way, with eBay display only.

## Open items

- **Days to sell.** Not shown yet: an imported listing's `listed_at` is when Listora read it, not
  when the seller listed it, so a day count from it would understate. It needs the marketplace's
  own listing date.
- **The call's thresholds** belong in the kit once the backtest (M0) sets them.
- **Sizes within a range** (a 6 and a 4 of the same leggings) are separate groups; the price
  screen does not narrow by size.

## Data

No tables of its own: it reads `sale`, `sale_item`, and `inventory_item` ([sales.md](sales.md),
[items.md](items.md)), and writes nothing.
