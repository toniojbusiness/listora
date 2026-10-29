# Sorting the Inventory and Sales lists

The Inventory and Sales lists can be put in another order with one Sort control, and each list
keeps the seller's choice. The server sorts, so an order covers every item or sale, not only the
pages the phone has loaded, and it stays fast with thousands of them. Code: the shared keyset
paging in `apps/api/src/sorting.ts`, each list's orders in `apps/api/src/items/sort.ts` and
`apps/api/src/sales/sort.ts`, and on the iPhone `SortMenu` (DesignSystem), `ItemSort+title`
(`InventoryFeature/Model/InventorySort.swift`), and `SaleSort+title`
(`SalesFeature/Model/SaleSort.swift`).

## The orders

`listItems` takes `sort` (the contract's `ItemSort`):

| `sort`                           | On the iPhone                   | Order                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `added_newest` (default)         | Recently added                  | Newest added first                                                                                                                                                                                    |
| `listed_newest`, `listed_oldest` | Date listed: newest, oldest     | When the item was first listed on any marketplace (the earliest `listed_at` of its listings); oldest is the longest listed. Never listed last                                                         |
| `price_high`, `price_low`        | Price: high to low, low to high | The item's list price; no price last                                                                                                                                                                  |
| `stale_first`                    | Stale first                     | Items still for sale (draft, ready, listed) that waited longest, aged like the profit dashboard's dead stock: from the purchase date, else from when it was added. Sold and archived items after them |
| `profit_high`                    | Profit: high to low             | Profit at list price: list price minus cost (a haul's share is the item's cost, [hauls.md](hauls.md)), before fees and shipping, as the item screen words it. No price or cost last                   |
| `name_az`                        | Name: A to Z                    | The title, ignoring case and surrounding spaces; untitled last                                                                                                                                        |

`listSales` takes `sort` (`SaleSort`):

| `sort`                    | On the iPhone                   | Order                                                                                                                                             |
| ------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sold_newest` (default)   | Recently sold                   | Newest sold first, then newest recorded                                                                                                           |
| `sold_oldest`             | Date sold: oldest               | Oldest sold first                                                                                                                                 |
| `price_high`, `price_low` | Price: high to low, low to high | The order's sale price (`Sale.salePrice`, its items' prices added up)                                                                             |
| `profit_high`             | Profit: high to low             | The order's profit, the same math as `saleMoney` in `@listora/sales`; sales without one (fees or a cost not known yet, canceled or returned) last |

The sort applies to what the filters and search leave, so "Listed, on eBay, by price" works. Every
order ends with the newest added item (or the newest sold, then newest recorded, sale), so rows
that tie keep one order on every page and on every read. Sorting sales by price or profit sorts
the seller's own orders; it never ranks one marketplace against another
([profit.md](profit.md#marketplaces-side-by-side-never-ranked)).

## Paging

Each order is a short list of non-null SQL terms (`SortTerm`): a nullable value becomes an
`is null` flag (so rows without it come last) and the coalesced value, timestamps are compared as
microseconds since the epoch, and the last term is the id. The page's query selects those terms as
`sort_key`, and `nextCursor` carries the last row's terms and the order's name (`s1:<sort>:<json>`,
base64url). The next page continues after them with a condition that handles terms in mixed
directions. A cursor issued for another order, or one the server did not issue, is
`400 invalid_request` ("Start from the first page"); cursors issued before sorting existed are
too.

No index was added. Per account the lists read the account's rows by their existing account
indexes and sort them in memory: at 2,000 items and 482 sales, beside four other sellers of the
same size, a sorted first page answered in 8 to 13 ms at the median and under 30 ms at p95, as
fast as the unsorted ones ([performance.md](performance.md); `npm run perf:api` has the sorted
scenarios). The query-count guard checks a sorted page reads in as many statements as an
unsorted one.

## On the iPhone

The Sort control is a pill at the start of Inventory's quick filters, and above the sales on the
Sales tab: it names the order in effect ("Price: high to low") and opens a menu of the orders
with the current one checked. A new order reloads the list from its first page. Each list keeps
its own choice in `UserDefaults` (`com.listora.inventory-sort`, `com.listora.sales-sort`), so the
next launch opens in it; an order this build does not know falls back to the default, and
`LISTORA_RESET_LOCAL_DATA` forgets both. Clearing Inventory's filters keeps the order, which is not
a filter, and the empty "No matching items" state ignores it. The Sales tab celebrates a new sale
only in the newest-first order, where the first row is the newest sale.

## Local development and tests

Nothing needs a credential. `items/sort.int.test.ts` and `sales/sort.int.test.ts` check every
order on a real Postgres, page by page two rows at a time (the same order as one page), with ties,
the haul share, fees and costs, the filters, and refused cursors. `InventoryModelsTests` and
`SalesModelsTests` check that the choice is sent, remembered across launches, and kept when the
filters clear; `InventorySortUITests` sorts Inventory by price on the local stack and relaunches
the app to find the order kept.
