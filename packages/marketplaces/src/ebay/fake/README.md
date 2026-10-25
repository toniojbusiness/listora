# fake-ebay

An HTTP server that speaks the part of eBay's APIs Listora uses, so the eBay adapter
(`../adapter.ts`), the worker, and the operation engine can be developed and tested with every
failure mode and no eBay credential. `FakeEbay.start()` runs it in a test;
`npm run dev:fake-ebay` runs it for local development at `EBAY_FAKE_URL` (default
`http://127.0.0.1:4200`), and the worker uses it with `EBAY_ENV=fake`.

It follows eBay's documented contract: request and response shapes, field rules, error codes and
messages, and state rules. Where eBay's documentation leaves something open, the fake makes a
choice and this file says so (see "Not documented by eBay"). When a fact here turns out wrong
against the real sandbox, fix the fake and this file together.

## What it serves

| Path                                                                             | eBay API                                                                                                                                       |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /identity/v1/oauth2/token`                                                 | OAuth: refresh-token, authorization-code, and client-credentials grants                                                                        |
| `POST /ws/api.dll`                                                               | Trading API: AddFixedPriceItem, VerifyAddFixedPriceItem, ReviseFixedPriceItem, EndFixedPriceItem, RelistFixedPriceItem, GetItem, GetSellerList |
| `POST /commerce/media/v1_beta/image/create_image_from_url`, `GET .../image/{id}` | Media API (photos into eBay Picture Services)                                                                                                  |
| `GET /commerce/taxonomy/v1/get_default_category_tree_id`                         | Taxonomy API                                                                                                                                   |
| `GET /commerce/taxonomy/v1/category_tree/0/get_category_suggestions`             | Taxonomy API (keyword match over the fixture)                                                                                                  |
| `GET /commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category`        | Taxonomy API (fixture aspects)                                                                                                                 |
| `GET /sell/fulfillment/v1/order`                                                 | Fulfillment API getOrders                                                                                                                      |
| `GET /developer/analytics/v1_beta/rate_limit/`                                   | Developer Analytics getRateLimits (Trading usage)                                                                                              |
| `GET /commerce/notification/v1/public_key/{id}`                                  | Notification API getPublicKey                                                                                                                  |
| `GET /itm/{id}`                                                                  | A listing's page (the `ViewItemURL`)                                                                                                           |

Signed notifications: `fake.notification(topic, data)` builds a notification exactly as eBay
signs it (`notifications.ts`), and `fake.deliver(url, notification)` POSTs it. The signing key
is a P-256 test key made at start; `getPublicKey` serves it. `notifications.test.ts` checks
that the procedure that verifies eBay's own SDK test vector (`__fixtures__/`, from
github.com/eBay/event-notification-nodejs-sdk, Apache-2.0) also verifies the fake's
notifications and rejects tampered ones.

Test controls: sellers (`addSeller`, `revokeSeller`, `authorizationCode`), token expiry
(`expireAccessTokens`), listings (`listings`, `listing`, `remove`, `sell`), every request
received (`requests`, `waitForRequest`), and faults (below).

## Fault injection

`fake.inject({ action, fault, sku?, itemId?, times? })` makes matching requests fail;
`setChaos(picker)` picks faults for randomized runs. Actions: `token`, `add`, `verify`, `revise`,
`end`, `relist`, `get_item`, `get_seller_list`, `media`, `taxonomy`, `orders`, `rate_limits`,
`public_key`.

| Fault                | What eBay sends                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `rate_limited`       | HTTP 429 (`errorId` 2001 "Too many requests"), optionally `Retry-After`; nothing applied       |
| `server_error`       | HTTP 5xx; with `afterApply` the change is applied first                                        |
| `system_error`       | Trading `Failure` 10007 "System error", `SystemError` (REST: 500); optionally after applying   |
| `reject`             | Trading `Failure` 37 "Input data ... is invalid" with the given message (REST: 400)            |
| `unauthorized`       | Trading 931 "Auth token is invalid" (REST: 401 errorId 1001; token: `invalid_grant`)           |
| `token_expired`      | Trading 21917053 "IAF token supplied is expired" (REST: 401)                                   |
| `call_limit`         | Trading 518 "Call usage limit has been reached"                                                |
| `timeout_after_send` | The change is applied and the answer comes after `delayMs`                                     |
| `hang`               | No answer until the server closes; optionally after applying                                   |
| `stale_read`         | GetItem shows the listing as it was before its latest change, within `staleReadWindowMs` of it |

Without faults the fake still refuses what eBay refuses: ending an ended listing (1047),
revising an ended one (291), relisting an active one (196), a repeated UUID (488, naming the
listing), a second active listing with a tracked SKU (21674), a missing required item specific
(21919303), a value outside a `SELECTION_ONLY` aspect (21916520), an unknown token (21916984),
an expired one (21917053), and Trading calls past the daily limit (518).

## The rules it follows, and where they come from

All pages are on developer.ebay.com unless noted, read on 2026-10-24.

**Trading API**

- Call format: one XML POST to `/ws/api.dll`; headers `X-EBAY-API-CALL-NAME`,
  `X-EBAY-API-SITEID` (0 for the US), `X-EBAY-API-COMPATIBILITY-LEVEL` (1487, the current
  release), and `X-EBAY-API-IAF-TOKEN` (the OAuth user token); namespace
  `urn:ebay:apis:eBLBaseComponents`; `Ack` Success, Warning, Failure; `Errors` with
  `ShortMessage`, `LongMessage`, `ErrorCode`, `SeverityCode`, `ErrorParameters`,
  `ErrorClassification` (`RequestError`, `SystemError`).
  [Making a call](https://developer.ebay.com/api-docs/user-guides/static/make-a-call/using-xml.html),
  [error handling](https://developer.ebay.com/api-docs/user-guides/static/make-a-call/error-handling.html),
  [release notes](https://developer.ebay.com/devzone/xml/docs/ReleaseNotes.html).
- Listing fields and limits: Title at most 80 characters and no HTML; Description at most
  500,000; ConditionDescription at most 1,000 and ignored for ids 1000-1499; 1 to 24 https
  `PictureURL`s (at most 500 characters each, 3,975 together, not mixing EPS and self-hosted);
  at most 45 item specifics, names and values at most 65 characters, at most 30 values; SKU at
  most 50, unique among active listings when `InventoryTrackingMethod` is `SKU`;
  `ListingType` `FixedPriceItem`; GTC duration; `SellerProfiles` with one shipping, payment, and
  return policy, or inline `ShippingDetails`, `ReturnPolicy`, and `DispatchTimeMax`; `UUID` of
  32 hex digits, and error 488 with the listing's id when it was used before.
  [AddFixedPriceItem](https://developer.ebay.com/devzone/xml/docs/reference/ebay/AddFixedPriceItem.html),
  [VerifyAddFixedPriceItem](https://developer.ebay.com/devzone/xml/docs/reference/ebay/VerifyAddFixedPriceItem.html)
  (ItemID always 0; eBay's placeholder picture `https://i2.ebayimg.com/abc/M28/dummy.jpg`),
  [UUIDType](https://developer.ebay.com/devzone/xml/docs/reference/ebay/types/UUIDType.html).
- Changes: [ReviseFixedPriceItem](https://developer.ebay.com/devzone/xml/docs/reference/ebay/ReviseFixedPriceItem.html)
  (the ItemID stays; a SKU-tracked listing needs `InventoryTrackingMethod` and `SKU`),
  [EndFixedPriceItem](https://developer.ebay.com/devzone/xml/docs/reference/ebay/EndFixedPriceItem.html)
  (`EndingReason` required), and
  [RelistFixedPriceItem](https://developer.ebay.com/devzone/xml/docs/reference/ebay/RelistFixedPriceItem.html)
  (a new ItemID every time, within 90 days of the end; the old listing names it in
  `ListingDetails.RelistedItemID`).
- Reads: [GetItem](https://developer.ebay.com/devzone/xml/docs/reference/ebay/GetItem.html) by
  ItemID, or by SKU for SKU-tracked listings; `ListingStatus` Active, Completed, Ended; the
  description only with `DetailLevel` `ItemReturnDescription` or `ReturnAll`; no revision or
  last-modified field (only `ReviseStatus.ItemRevised`).
  [GetSellerList](https://developer.ebay.com/devzone/xml/docs/reference/ebay/GetSellerList.html):
  a start or end time range under 120 days, `EntriesPerPage` 1 to 200, `SKUArray`.
- Error codes and texts: [Errors by number](https://developer.ebay.com/devzone/xml/docs/reference/ebay/errors/errormessages.htm)
  and [top errors per call](https://developer.ebay.com/devzone/xml/docs/reference/ebay/errors/errorsbycall.html).
- Conditions: [condition ids](https://developer.ebay.com/api-docs/sell/static/metadata/condition-id-values.html)
  (2990 "Pre-owned - Excellent" and 3010 "Pre-owned - Fair" only in apparel categories).
- Size standardization: Trading error 21920468 blocks non-standard `Size` values since
  2026-08-24 ([release notes](https://developer.ebay.com/devzone/xml/docs/ReleaseNotes.html),
  [blog](https://developer.ebay.com/updates/blog/size-standardization)).
- Call limits: Trading 5,000 calls a day by default, Media POSTs 50 per 5 seconds per seller
  ([API call limits](https://developer.ebay.com/develop/api/sell/api_call_limits)); usage and
  its reset time from
  [getRateLimits](https://developer.ebay.com/api-docs/developer/analytics/resources/rate_limit/methods/getRateLimits)
  (`api_context=tradingapi`).

**REST APIs** (shapes from eBay's OpenAPI documents, `https://developer.ebay.com/api-docs/master/<group>/<api>/openapi/3/<file>.json`)

- OAuth: token endpoint, Basic client credentials, `expires_in` 7200,
  `refresh_token_expires_in` 47304000, errors as `{ error, error_description }`
  ([authorization guide](https://developer.ebay.com/develop/guides/sell/authorization)).
- Media: `apim.ebay.com/commerce/media/v1_beta`, `createImageFromUrl` (https only; 201 with a
  `Location` header and `imageUrl`, `expirationDate`; errors 190201 to 190204), scope
  `sell.inventory` (`commerce_media_v1_beta_oas3.json`).
- Taxonomy: `getDefaultCategoryTreeId` (EBAY_US is tree 0), `getCategorySuggestions` (ancestors
  from the immediate parent up; the sandbox answers it with boilerplate names),
  `getItemAspectsForCategory` (`aspectRequired`, `aspectMode` FREE_TEXT or SELECTION_ONLY,
  `itemToAspectCardinality`) (`commerce_taxonomy_v1_oas3.json`).
- Fulfillment: `getOrders` with `filter=lastmodifieddate:[...]` or `creationdate`, `limit` up to
  200, `offset`, `next` (`sell_fulfillment_v1_oas3.json`).
- Notifications: the `{ metadata, notification }` envelope and the `data` of
  `ORDER_CONFIRMATION`, `MARKETPLACE_ACCOUNT_DELETION`, `AUTHORIZATION_REVOCATION`
  ([topics](https://developer.ebay.com/develop/api/sell/notification_events), event specs at
  `https://developer.ebay.com/develop/api/spec/events/<TOPIC>.yaml`); `X-EBAY-SIGNATURE` and
  `getPublicKey` (`commerce_notification_v1_oas3.json`, and eBay's
  [Node SDK](https://github.com/eBay/event-notification-nodejs-sdk)).
- REST errors: the `errors[]` envelope, 1001 invalid access token (401), 1100 access denied
  (403), 2001 too many requests (429)
  ([using eBay RESTful APIs](https://developer.ebay.com/develop/guides/using-ebay-restful-apis)).

**Category fixture** (`taxonomy.json`): every leaf the canonical map (`../categories.ts`) uses,
plus three kids' leaves, with names and ancestors from eBay's US category structure
([US_New_Structure_Jun2026.csv](https://ir.ebaystatic.com/cr/v/c01/US_New_Structure_Jun2026.csv),
linked from [category changes](https://pages.ebay.com/sellerinformation/news/categorychanges.html)).

## Not documented by eBay

These are the fake's choices where eBay's pages are silent. `npm run ebay:sandbox-check`
exercises the real behavior; correct the fake when it differs.

- **Aspect value lists.** eBay publishes allowed values only through `getItemAspectsForCategory`,
  so the fixture's Size, Size Type, Department, and Color lists are curated (letter sizes `XXS`
  to `6XL`, women's `00` to `24` and `1X` to `6X`, waists `24` to `50`, US shoe sizes `4` to
  `16`), and shoes use `US Shoe Size`. The sandbox check writes the real lists to
  `.local/ebay-sandbox-check.json`.
- **Which code for which refusal on the FixedPriceItem calls.** 1047, 291, and 196 are
  documented for EndItem, ReviseItem, and RelistItem; the fake uses them for the fixed-price
  variants too. GetItem answers 17 for any unknown or removed id, and 37 for one that is not a
  number.
- **Error 488's parameters.** The listing id is in the long message ("item ID=..."); the fake
  also returns it as `ErrorParameters` 1.
- **Gateway rate limiting** of the Trading API is an HTTP 429 with an optional `Retry-After`.
- **Stale reads.** eBay does not document how far its reads lag; the fake serves the previous
  state only when a `stale_read` fault asks, within `staleReadWindowMs` of the change.
- **The sandbox Media host** is `apim.sandbox.ebay.com` (eBay's OpenAPI lists only production
  hosts).
- **Item ids** are 12 digits from 110000000001, like the sandbox's.
