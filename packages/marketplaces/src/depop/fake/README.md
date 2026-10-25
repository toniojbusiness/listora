# fake-depop

An HTTP server that speaks the part of Depop's Selling API Listora uses, so the Depop adapter
(`../adapter.ts`), the worker, and the operation engine can be developed and tested with every
failure mode and no Depop credential. `FakeDepop.start()` runs it in a test;
`npm run dev:fake-depop` runs it for local development at `DEPOP_FAKE_URL` (default
`http://127.0.0.1:4300`), and the worker uses it with `DEPOP_ENV=fake` for listings on an `api`
connection.

It follows Depop's published contract. Where Depop's documentation leaves something open, the
fake makes a choice and this file says so (see "Not documented by Depop"). When a fact here turns
out wrong against Depop's staging API, fix the fake and this file together.

## Depop's spec, vendored

`openapi.yaml` is a byte-for-byte copy of https://partnerapi.depop.com/api-docs/openapi.yaml,
downloaded on 2026-10-24 (SHA-256 in `spec.ts`, `DEPOP_OPENAPI_SOURCE`, checked by a test).
`spec.ts` compiles it with Ajv: the fake refuses a request whose path parameters or body break
it (400 `bad-request`, or 422 `validation` for a body), and checks every JSON response it sends
against the operation's response schema for that status. A response that breaks the spec is
answered as a 500 instead and recorded in `fake.specViolations`, which every Depop test expects
to stay empty. To refresh the copy:

```sh
curl -sSL -o packages/marketplaces/src/depop/fake/openapi.yaml \
  https://partnerapi.depop.com/api-docs/openapi.yaml
shasum -a 256 packages/marketplaces/src/depop/fake/openapi.yaml  # into DEPOP_OPENAPI_SOURCE
```

then run the Depop tests and read Depop's changelog for rule changes the schema can't show.

## What it serves

| Path                                                                                   | Depop                                                    |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `GET /settings/oauth/apps/`                                                            | The consent page (Depop's website): redirect with a code |
| `POST /api/v1/oauth2/access-token/`                                                    | Authorization code (PKCE S256) and refresh token grants  |
| `PUT`, `GET`, `PATCH`, `DELETE /api/v1/products/by-sku/{sku}/` (and `by-slug/{slug}/`) | Create or update, read, patch, delete                    |
| `POST /api/v1/products/by-sku/{sku}/mark-as-sold/` (and by slug)                       | A sale elsewhere                                         |
| `POST /api/v1/products/by-sku/{sku}/purchase/`                                         | A test purchase (staging only), with its `v1:order.new`  |
| `GET /api/v1/orders/`, `GET /api/v1/orders/{purchase_id}/`                             | Orders, newest first, with a cursor                      |
| `GET /api/v1/shop/`, `/seller-addresses/`, `/{address_id}/shipping-providers/`         | The seller, their addresses, and Depop Shipping options  |
| `GET /status`, `GET /api-docs/openapi.yaml`                                            | Status, and the vendored spec                            |

Signed webhooks: `fake.webhook(eventType, data, { secret })` builds a delivery exactly as Depop
signs it, and `fake.deliver(url, webhook)` POSTs it with `X-Depop-Signature` and
`X-Depop-Timestamp`. With `options.webhook`, a purchase delivers its `v1:order.new` itself.

Test controls: sellers and grants (`addSeller`, `grant`, `developmentSellerId`, `consentAs`,
`denyNextConsent`, `revokeSeller`, `expireAccessTokens`), products (`products`, `product`,
`deleteInApp`, `ban`, `purchase`), `orders`, every request received (`requests`,
`waitForRequest`, `tokenRequests`), `specViolations`, and faults (below).

## Fault injection

`fake.inject({ action, fault, sku?, times? })` makes matching requests fail; `setChaos(picker)`
picks faults for randomized runs. Actions: `consent`, `token`, `put`, `patch`, `delete`,
`mark_sold`, `get`, `purchase`, `orders`, `order`, `shop`, `addresses`, `shipping_providers`,
`status`, `spec`.

| Fault                   | What Depop sends                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `rate_limited`          | 429 `RateLimitErrorResponse`, `Retry-After` when given, per seller or for the client      |
| `server_error`          | A 5xx (503 by default) `generic_error`; with `afterApply` the change is applied first     |
| `reject`                | 422 with the given code (`validation` by default) and message; nothing applied            |
| `unauthorized`          | 401 `unauthorized` from the API; `invalid_grant` from the token endpoint                  |
| `partner_access_denied` | 401 `partner_access_denied`                                                               |
| `timeout_after_send`    | The change is applied and the answer comes after `delayMs`                                |
| `hang`                  | No answer until the server closes; optionally after applying                              |
| `stale_read`            | A read shows the product as it was before its latest change                               |
| `not_visible`           | A read answers 404 `product_not_found` for a product that exists (just after creating it) |

Without faults the fake still refuses what Depop refuses (below), and enforces Depop's rate
limits (smaller ones for tests with `rateLimits`).

## The rules it follows, and where they come from

All pages are on partnerapi.depop.com/api-docs unless noted, read on 2026-10-24.

**OAuth** ([authentication](https://partnerapi.depop.com/api-docs/concepts/authentication/),
[your first OAuth connection](https://partnerapi.depop.com/api-docs/getting-started/your-first-oauth-connection/),
[refresh tokens](https://partnerapi.depop.com/api-docs/how-to-guides/using-oauth-refresh-tokens/))

- Consent at `https://www.depop.com/settings/oauth/apps/` with `response_type=code`,
  `client_id`, `redirect_uri` ("must exactly match one of the Redirect URIs registered"),
  `state`, `scope` ("Joined with +"), `code_challenge`, `code_challenge_method=S256`. Approval
  redirects with `code` ("A temporary (10-minute), single-use authorization code") and `state`;
  denial with `error=access_denied`, `error_description`, and `state`.
- The token endpoint takes a form body with `client_id` and `client_secret`; the code exchange
  needs `redirect_uri` and a `code_verifier` (43 to 128 of `[A-Za-z0-9._~-]`) whose SHA-256,
  base64url, is the challenge. Access tokens last 3600 seconds; the grant lasts a year from
  consent.
- "The previous Access Token and Refresh Token are immediately invalidated and cannot be used
  again", and "The new Refresh Token inherits the original expiration date of the grant".
  Errors use `OAuthErrorResponse` (`invalid_grant`, `invalid_request`; 401 for client
  authentication).
- Scopes: a token lacking an operation's scope is refused with 403 `insufficient_scope`
  ("Required scope: products_write").

**Products** (openapi.yaml, [errors](https://partnerapi.depop.com/api-docs/concepts/errors/))

- PUT by SKU creates a product when the SKU is new and updates it when it is on sale. "SKUs must
  be unique per seller — creating a listing with a SKU that already exists (including on sold or
  deleted products) fails with a duplicate-SKU error", and a banned product can't be modified
  (`product_has_been_banned`). "Existing product sizeId can not be changed."
- Refusals: more than 8 pictures (`too_many_pictures`), more than 5 hashtags or an email address
  in the description (`invalid_description`), a price under 1.00 or with more than 2 decimals, a
  currency other than the seller's (`validation`), an unknown department (`invalid_department`),
  a picture URL that isn't https (`ingest_picture_error`), half a size (`invalid_size`), both or
  neither of `national_shipping_cost` and `depop_shipping` (`validation`), manual shipping for a
  US seller (`manual_shipping_not_allowed`: "Manual shipping is not available to most US
  sellers"), and an address that isn't the seller's ("Address does not belong to this user").
- PATCH changes an on-sale product only (`product_not_on_sale` otherwise); quantity 0 sells it
  out.
- DELETE "is idempotent - it will return a successful response (200) even if the product doesn't
  exist". Mark-as-sold: "If the product is not in a selling state, this endpoint will still
  return successfully but will remain in the same state"; a product it can't find is 404.
- A product not found is 404 `product_not_found`, which "can take a short time" for a new one.

**Rate limits** ([rate limits](https://partnerapi.depop.com/api-docs/concepts/rate-limits/)):
per seller, creates and full updates 200 per 10 seconds and everything else 6,000 per minute;
per application 30,000 per minute; a 429 carries `Retry-After` and `X-RateLimit-*`, and its
`detail` names `user id` or `client id`.

**Webhooks** ([webhooks](https://partnerapi.depop.com/api-docs/concepts/webhooks/),
[validate webhooks](https://partnerapi.depop.com/api-docs/how-to-guides/validate-webhooks/)): the
envelope `{ id, event_type, created_at, data }`; order webhooks' id "is derived from the purchase
ID"; `X-Depop-Signature` is the hex HMAC-SHA256 of `<timestamp>.<body>` with the configuration's
secret, and `X-Depop-Timestamp` the seconds since the epoch.

## Not documented by Depop

- **Deleted products stay readable.** The status list has `STATUS_DELETED_*`, so a deleted
  product reads back with one (`STATUS_DELETED_ONSALE` when it was on sale) rather than 404.
- **Restocking.** The restocking guide says a deleted or sold listing can be created again under
  its SKU with the legacy `PUT /api/v1/products/{sku}/`, while the errors guide says a SKU of a
  sold or deleted product fails with `duplicate_sku`. The fake follows the errors guide, and
  Listora relists under a new SKU, which works either way.
- **Taxonomy.** Depop serves product types, size sets, and attributes only from
  `api.depop.com/api/v3/attributes/`, behind bot detection, so the fake accepts any well-formed
  product type and doesn't check sizes or attributes against it.
- **Which country Listora's items are in.** The fake's sellers are in the US (USD, Depop
  Shipping with USPS from a California address).
- **Slugs** are the description's first words and the product id; product ids and purchase ids
  count up; pictures are rehosted under `media-photos.depop.com`.
- **Updated time** has whole seconds, as in Depop's examples.
- **Webhook configuration** (`/api/v1/webhooks/`) is API-key-only and not served; deliveries go to
  `options.webhook`.
