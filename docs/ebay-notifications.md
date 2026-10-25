# eBay notifications and order sync

Plan task T-17. How Listora learns about eBay sales, listing changes, revoked access, and
account deletions, and how it stays correct when a notification never arrives. Code:
`packages/marketplaces/src/ebay/notification-*.ts` (eBay's APIs),
`packages/sales` (what Listora does with them), `apps/api/src/webhooks/ebay.ts` (the
endpoint), and `packages/operations/src/resync.ts` (listing read-backs).

## Sources

All on developer.ebay.com, read 2026-10-24: the Notification API
(`commerce_notification_v1_oas3.json`), the topic list
(`/develop/api/sell/notification_events`), each topic's asyncapi document
(`/develop/api/spec/events/<TOPIC>.yaml`), and the
[Marketplace Account Deletion guide](https://developer.ebay.com/develop/guides/sell/marketplace-user-account-deletion).
Signatures are checked the way eBay's own SDKs do (github.com/eBay/event-notification-nodejs-sdk).

## Subscriptions

eBay delivers to one **destination**: the API's `/webhooks/ebay` at
`EBAY_NOTIFICATION_ENDPOINT`, with `EBAY_NOTIFICATION_VERIFICATION_TOKEN`. The worker keeps the
subscriptions in place (`EbayNotificationSubscriptions`); every step is idempotent.

| Job                         | When                                    | What                                                                                                          |
| --------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `ebay_notification_setup`   | Worker start, and 04:23 UTC every day   | The alert email (`EBAY_NOTIFICATION_ALERT_EMAIL`; eBay requires one), the destination, the application topics |
| `ebay_seller_subscriptions` | When a seller connects, and after setup | The seller topics, with that seller's own token                                                               |

| Topic                          | Scope       | Token                    | Listora does                                             |
| ------------------------------ | ----------- | ------------------------ | -------------------------------------------------------- |
| `MARKETPLACE_ACCOUNT_DELETION` | Application | Application (client)     | Deletes everything it holds about that eBay user (below) |
| `AUTHORIZATION_REVOCATION`     | Application | Application (client)     | Marks the seller's connections `revoked` at once         |
| `ORDER_CONFIRMATION`           | Seller      | The seller's (auth code) | Reads the order and records the sale for auto-delist     |
| `LISTING`                      | Seller      | The seller's (auth code) | Reads the listing back (drift resync)                    |

Each topic is subscribed with its newest JSON schema version from `getTopic`, enabled, and
pointed at the destination; one that differs is updated, never duplicated. eBay checks the
endpoint with a challenge when the destination is created or changed, so the API must serve
`/webhooks/ebay` before the worker's first setup run. A refusal that needs a person (no alert
email, a failed challenge, a topic eBay will not subscribe) is logged as an error with
`event: "ebay_notification_setup"` or `"ebay_notification_subscription"` and retried the next
day; an outage throws, so the queue retries it with backoff. A seller token eBay refuses is
refreshed once and tried again. Without a token vault the worker keeps only the destination
and the application topics.

`LISTING` needs the `sell.listing.read` scope, which Listora does not ask sellers for yet (see
open items), so for now eBay refuses that subscription (`not_authorized`) and listing drift is
found only through sales and operations.

## The endpoint

`/webhooks/ebay` is eBay's contract, not the app's, so it sits outside `/v1` and `openapi.yaml`.

- `GET ?challenge_code=...` answers `{"challengeResponse": "<hex>"}` (`application/json`), the
  SHA-256 of challengeCode + verificationToken + endpoint, in that order.
- `POST` reads the body as the exact text eBay sent and checks `X-EBAY-SIGNATURE`: the
  base64 JSON header names the key (`kid`); `getPublicKey` (application token) returns the PEM
  key; the signature is ECDSA over the body with the key's digest (SHA1). Keys are cached for an
  hour, as eBay asks, and an unknown key id for ten minutes (a bounded cache), so forged headers
  cannot run up the Notification API's call limit. Answers:

| Status | When                                                                                            |
| ------ | ----------------------------------------------------------------------------------------------- |
| `204`  | Verified and stored, a repeat, or a notification Listora does not act on (eBay stops resending) |
| `412`  | The signature is missing, malformed, wrong, or from an unknown key; nothing is stored           |
| `503`  | eBay's key could not be read now; eBay delivers it again                                        |
| `400`  | A body that is not JSON                                                                         |

A verified notification is stored as one `inbound_event` per Listora connection of that eBay
user (`source = ebay_webhook`, `provider_event_id` = eBay's `notificationId`, the user's id in
`external_user_id`), in the transaction that also does or schedules its work. eBay resends
until it gets a 2xx, so repeats are normal: the unique event key turns each into a no-op.

## Sales: webhook and poll

`ORDER_CONFIRMATION` carries no prices, so the worker reads the order (Fulfillment `getOrder`)
with the seller's token. The **order poll** (`ebay_order_poll`, every 5 minutes, fanned out as one
`ebay_connection_order_poll` job per connected seller) reads every order changed since 10
minutes before its last complete run (`marketplace_connection.orders_polled_through`) with
`getOrders`. Both end in `recordEbayOrder`:

- An order is a sale once it is `PAID` (or `PARTIALLY_REFUNDED`) and not canceled. A
  confirmation whose order still shows another payment status is retried, since eBay's views lag.
- `recordSale` matches each line to the account's eBay listing by listing id (verified or
  pending), else by SKU, and records the `sale` (unique per account, marketplace, and order id)
  with one `sale_item` per item, so the webhook and the poll record an order once. An order with
  no line Listora knows is not recorded.
- The same transaction adds a `sale_recorded` job, the domain event the auto-delist
  orchestrator (T-20) consumes. Until T-20 registers that task, its jobs wait in the queue.
- Each poll-found order also gets one `poll` inbound event (`order:<id>`), so the next poll
  skips it at once.
- No buyer data is kept: only the order id, line prices, shipping charged, sale time, and the
  ship-by date.

A seller who has to reconnect fails the confirmation's event with that reason; the poll records
the sale after they reconnect, because its mark only moves after a complete run.

Each poll costs one Fulfillment call per page. eBay's default of 100,000 calls a day per
application covers about 340 sellers; the Growth Check (T-35) raises it.

## Listing drift resync

`listing_resync` (`runListingResync`) reads a listing back when eBay says it changed (`LISTING`)
or sold, so a change the seller made in Seller Hub or the eBay app reaches Listora. It runs in
the listing's queue (`listing:<id>`), so it never overlaps an operation step, and it leaves alone
a listing with an unfinished operation (that operation's read-back decides) or a pending id. It
writes only what a read shows (status, `remote_snapshot`, `last_verified_at`). eBay's reads carry
no revision, so a read that differs from the row is recorded only when a second read 30 seconds
later agrees (at most three rounds). Only an authoritative not-found ends a listing.

## Revoked access

`AUTHORIZATION_REVOCATION` is handled while the notification is received: every connection of
that eBay user is marked `revoked` and its tokens are deleted (`recordAuthorizationRevocation`,
`@listora/connections`), so the app asks the seller to reconnect at once.

## Marketplace Account Deletion

eBay requires every application to subscribe and to delete the user's data irreversibly. The
notification adds one `ebay_user_deletion` job per eBay user, whether or not Listora knows them,
and stores nothing about them first. `purgeEbayUser` then deletes, in one transaction:

- every `marketplace_connection` to that eBay user, in every account (tokens, eBay user id, user
  name);
- the eBay listing snapshots read back under those connections, and the listings' link to them;
- every eBay `inbound_event` about them.

The Listora account's own items, listing history, and sales stay: they are the Listora user's
records, and sales are kept for tax. Listora stores no buyer data, so a buyer's deletion finds
nothing. Database backups expire with their retention period. The purge logs counts only.

## Local development

With `EBAY_ENV=fake` and the `.env.example` values, run `npm run dev:fake-ebay`,
`npm run dev:api`, and `npm run dev:worker`. The worker subscribes Listora on the fake (which
accepts the local http endpoint), and the fake then publishes eBay's events to the API itself:
`ORDER_CONFIRMATION` when a test sells a listing (`fake.sell`), `LISTING` when a Trading call
changes one, `AUTHORIZATION_REVOCATION` on `fake.revokeSeller`, and
`MARKETPLACE_ACCOUNT_DELETION` on `fake.deleteUser`, all signed with the fake's test key.

## Open items

- Ask sellers for `sell.listing.read` once the sandbox confirms the keyset may request it (a
  scope the keyset lacks breaks the consent page for everyone), so `LISTING` can be subscribed.
- Order changes after the sale (cancellations, returns) and eBay's fee lines are T-26.
- T-35 makes the deletion endpoint live on staging for eBay's production keyset.
