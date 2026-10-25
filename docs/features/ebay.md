# eBay

The eBay adapter, the fake eBay it is built and tested against, and the check against eBay's
sandbox. The adapter framework it implements is in [marketplaces.md](marketplaces.md).

## The adapter

**The eBay adapter** (`ebay/`, `createEbayAdapter` from `EBAY_ENV` and the other `EBAY_*` keys)
lists through the Trading API (AddFixedPriceItem, ReviseFixedPriceItem, EndFixedPriceItem,
RelistFixedPriceItem, GetItem), so listings stay editable in Seller Hub, with photos copied into
eBay Picture Services by the Media API. Its rules:

- **Payload** (`payload.ts`, golden-tested): the variant's keyword title (at most 80
  characters) and its description as HTML (`description.ts`, which reads eBay's HTML back to the
  same text); the category from the variant's `categoryRef`, else the canonical category map
  (`categories.ts`, eBay US leaf ids from eBay's published category structure); the condition
  id for the category (`conditions.ts`: apparel has 2990/3000/3010 for the three pre-owned
  grades); and item specifics (Brand, Department, the standard size from `sizes.ts`, Color,
  Material, Pattern, MPN), with the variant's own aspects winning by name. Validation refuses
  what eBay would (no category, condition, or standard size for clothing and shoes; titles with
  HTML or edge spaces; eBay's length and count limits).
- **Preparing** a listing (`prepareListing`, for the API to call before publishing): the
  category is the best Taxonomy suggestion inside the mapped category's branch (the map is the
  input; the sandbox's suggestions are boilerplate, so there the map alone decides), the item
  specifics are matched to the values eBay allows for it (eBay blocks non-standard sizes since
  August 2026), and VerifyAddFixedPriceItem checks the result without listing anything.
- **Duplicate protection.** A create or relist carries `Item.UUID`, derived from the operation's
  idempotency key; eBay answers a repeat with error 488 naming the listing, which counts as
  accepted. Listings are tracked by SKU (`externalSku`, else the listing id), so eBay also refuses
  a second active listing with that SKU, and a create whose answer was lost is found by SKU.
- **Revise.** ReviseFixedPriceItem keeps every field it is not sent, so a revise whose
  payload has no condition description removes it with `DeletedField`
  `Item.ConditionDescription`, and eBay never keeps showing cleared notes or flaws.
- **Read-back.** GetItem by id, or by SKU before eBay's id is known. **eBay's reads carry no
  revision or last-modified time** (only a "revised" flag), so the adapter declares `readFreshness:
'none'` and the engine confirms after two matching reads a delay apart
  ([operations.md](operations.md)). Error 17 for an id ("the listing has been deleted") is the only
  authoritative absence; an empty SKU lookup never is. A sold-out listing reads as `sold`. eBay
  marks its own sales sold, so `markSold` is `not_needed`.
- **Errors.** 429s, 5xx, eBay `SystemError`s (10007), and expired access tokens are transient;
  error 518 (the daily limit) waits for the reset; 931, 932, 16110, and refused refresh tokens
  are `reauth_required`; ending an ended listing (1047) is `confirmed` for a read-back to decide;
  other refusals are `rejected` with eBay's message. A REST 401 refreshes the token and tries
  once more (only reads and photo uploads, which change no listing).
- **Daily-call budget** (`budget.ts`): every Trading call takes one call from the application's
  daily budget (5,000 by default), which keeps a reserve for ends and read-backs and re-reads the
  real usage from eBay's Developer Analytics API (the app-wide daily Trading rate, never a
  per-call or short-window one), so several workers share one quota.
- **Tokens.** The adapter gets the seller's user token from an `EbaySellerSource`. In the worker
  with a token vault, that is `ConnectionSeller` (`@listora/connections`): each connection's own
  tokens ([connections.md](connections.md)). Without a vault, `RefreshTokenSeller` serves one seller
  from `EBAY_USER_REFRESH_TOKEN` (the fake's development seller with `EBAY_ENV=fake`), bound to the
  one connection `EBAY_USER_CONNECTION_ID` names. That is a development and sandbox convenience
  only: `EBAY_ENV=production` refuses both keys, so one seller's account never acts for every
  Listora user. Any other connection, a listing with no connection, and every connection without a
  configured seller get `reauth_required` ("Connect eBay") on every path (execute, read-back, health
  check, preparing). Token refreshes are single-flight, and the shared refresh runs under the OAuth
  client's own timeout, so one caller's deadline never fails the others. The health check is one
  Fulfillment `getOrders` call.

## The fake eBay

The fake eBay (`ebay/fake`, `npm run dev:fake-ebay`) serves the Trading, OAuth (with the consent
page and token revocation), Commerce Identity, Media, Taxonomy, Fulfillment, Developer
Analytics, and Notification endpoints (subscriptions with eBay's endpoint challenge) the
adapter, eBay connect, and the notifications use, signs notifications the way eBay does and
delivers its own events to subscribed endpoints ([ebay-notifications.md](ebay-notifications.md)), and injects eBay's failure modes; its README cites the eBay
documentation it follows and lists what eBay leaves undocumented. `npm run ebay:sandbox-check`
runs the adapter against eBay's sandbox once the keys are in `.env`
([Sandbox check](#sandbox-check)).

## Connecting locally

The fake eBay server stands in for eBay's consent page, token endpoint, and seller identity, so
connecting an eBay account needs no eBay credential. With `.env.example`'s `EBAY_ENV=fake`, add a
token vault key to `.env` (any 32 random bytes), then run `npm run dev:fake-ebay` next to the
API and the worker:

```sh
TOKEN_ENCRYPTION_KEY=<output of openssl rand -base64 32>
```

In the app, Settings > Marketplaces > Connect eBay opens the fake consent page ("Agree and
Continue"), which sends the browser back through the API's callback to the app.

## Sandbox check

Everything builds and tests against the fake eBay (`packages/marketplaces/src/ebay/fake`). Once
the eBay developer keys exist, one command checks the adapter against eBay's real sandbox:

1. On [developer.ebay.com](https://developer.ebay.com) (My Account > Application Keys), take the
   **sandbox** keyset's App ID and Cert ID. Under User Tokens, add an eBay Redirect URL (RuName)
   and note its name. Create a sandbox test user
   ([sandbox user registration](https://developer.ebay.com/sandbox/register)).
2. Put `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, and `EBAY_RUNAME` in `.env`.
3. `npm run ebay:sandbox-token`: open the URL it prints, sign in as the sandbox test user, agree,
   and paste the address of the page eBay shows. It saves `EBAY_USER_REFRESH_TOKEN` in `.env`.
4. `npm run ebay:sandbox-check`. The check binds the test user to its own connection. To have a
   sandbox worker list for that user, also set `EBAY_USER_CONNECTION_ID` to the id of the
   Listora eBay connection (`marketplace_connection` row) it lists for. Listings on any other
   connection, or on none, get "Connect eBay". Production refuses both keys: there, every
   eBay connection gets its own token with eBay connect.

The check uses about 15 Trading calls. It tests both OAuth grants, that every category Listora
maps to is still an eBay leaf, the health check, preparing a listing (item specifics and eBay's
dry run), and one listing's whole life (create, duplicate protection, read-back, price change,
end, relist), and it ends every listing it creates. It writes eBay's real size lists for the
mapped categories to `.local/ebay-sandbox-check.json`, to refresh the fake's fixtures. If eBay
refuses listings without business policies for the test seller, set the three
`EBAY_*_POLICY_ID` keys. Without the keys, `npm run check` skips the sandbox test.
