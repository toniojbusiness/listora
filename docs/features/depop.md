# Depop

Depop's partner API is granted per application (gate G-Depop). Until then, and for every
seller without an API connection, Depop runs assisted, and browser automation joins it when
the runner lands ([automation.md](automation.md)). The adapter framework it implements is in
[marketplaces.md](marketplaces.md). Depop's Pricing Inspiration may be shown only inside that
Depop listing ([pricing.md](pricing.md)).

## The adapter

**The Depop adapter** (`depop/`, `createDepopAdapter` from `DEPOP_ENV` and the other `DEPOP_*`
keys) lists through Depop's Selling API. It stays dormant until Listora's partner access is
granted: `ConnectionAwareAdapter` serves it only to connections whose mode is `api`, and every
other Depop listing runs assisted. Its rules:

- **SKUs are listing ids.** Depop creates and addresses a product by the SKU sent (`PUT
/api/v1/products/by-sku/{sku}/` creates or updates) and never reuses a SKU, so each Depop listing
  gets a SKU of its own (`sku.ts`): the item's SKU and the listing's generation, `AJ-000184-D1`, and
  `-D2` for the relist, which is a new product. The engine names it before sending (`newListingId`,
  [marketplaces.md](marketplaces.md#adapter-model)). A listing the user linked from a share is known
  by its product slug and addressed through the `by-slug` endpoints; a relist of it gets a Listora
  SKU.
- **Payload** (`payload.ts`, golden-tested): Depop listings have no title, so the description is
  the listing text, with the hashtags on their own last line (`depopDescription` in
  `@listora/shared`, shared with the item analysis) and read back without them. Validation
  refuses what Depop refuses (1 to 8 photos, at least $1.00, 1,000 characters and 5 hashtags,
  no email addresses) and needs a department and product type. Depop's full taxonomy is behind
  bot detection (Listora never works around it), so `taxonomy.ts` maps only the product types
  Depop's documentation names; any other item names its Depop product type in the variant's
  `categoryRef` and its size in the aspects `size_set_id` and `size_id`, until a taxonomy
  snapshot arrives with partner access. The seller's address and shipping (Depop Shipping, or a
  national cost) are added when sending.
- **Writes and read-back.** Edits are `PUT` (the whole listing) or `PATCH` (the price); an end
  is `DELETE`, which answers 200 even for a missing product, and a sale elsewhere is
  `mark-as-sold`, which succeeds for a product that isn't on sale: their 200 is only `confirmed`,
  and the `GET` read-back decides. A product Depop can't find is never authoritative ("a newly
  created listing can take a short time to become retrievable"), and reads carry no revision
  (`updated_at` has whole seconds), so `readFreshness` is `none`. Deleted and banned products
  read as `ended`, bought or marked-sold ones as `sold`.
- **Errors.** 429s, 5xx, and failures before sending are transient; a timeout after sending is
  unknown; a token Depop refuses is refreshed and the call sent once more (nothing was done);
  a refused grant or a missing scope is `reauth_required`; Depop's other refusals
  (`duplicate_sku`, `product_not_on_sale`, validation) are `rejected` with Depop's reason.
- **Tokens** (`oauth.ts`, `tokens.ts`). Sellers connect with the authorization code flow and PKCE
  (S256). Depop rotates refresh tokens and invalidates the old ones at once, so refreshes are
  single-flight per connection (ten callers, one refresh), the new tokens are kept in memory before
  they are stored, a failed write keeps them in use and is stored on the next call (clearing a
  "reconnect" mark another process set meanwhile), and a refused refresh token is checked against
  the store first, since another process may have refreshed. The tokens live in a `DepopTokenStore`;
  until Depop connect (T-24) implements it over the token vault, `MemoryDepopTokenStore` holds the
  one development or sandbox seller (`DEPOP_USER_REFRESH_TOKEN`, refused in production).
- **Rate limits** (`rate-limits.ts`): Depop's per-seller allowances (creates and full updates 200
  per 10 seconds, everything else 6,000 a minute) and its application-wide 30,000 a minute
  (`DEPOP_APP_REQUESTS_PER_MINUTE` is this process's share), as sliding windows a little longer
  than Depop's. A call waits up to 2 seconds for room, else it is held back as transient.
- **Sales.** `listOrders` reads the orders poll; `receiveDepopWebhook` verifies
  `X-Depop-Signature` (HMAC-SHA256 of `<timestamp>.<raw body>`, five minutes' tolerance) and
  reads `v1:order.*` and `v1:product.*` events, keyed for deduplication by id, type, and time.
  The inbound endpoint and the auto-delist that use them are later tasks (T-17, T-23).

The fake Depop (`depop/fake`, `npm run dev:fake-depop`) checks every request and response against
a byte-for-byte copy of Depop's published `openapi.yaml`, follows Depop's documented rules, OAuth
(PKCE, rotation), rate limits, and signed webhooks, and injects Depop's failure modes; its README
cites the Depop pages it follows and what they leave open.
