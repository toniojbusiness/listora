# Marketplace adapters

All marketplace logic lives behind one adapter interface in `@listora/marketplaces`. This file
covers the framework, the assisted adapters, and how listings reach the API. The eBay adapter
is in [ebay.md](ebay.md), Depop in [depop.md](depop.md), and browser automation for the
marketplaces without an API in [automation.md](automation.md). Every write an adapter makes
goes through the operation engine ([operations.md](operations.md)).

## Adapter model

All marketplace logic lives behind one `MarketplaceAdapter` interface in `@listora/marketplaces`
(`adapter.ts`). The engine and the UI never branch on the marketplace name. They branch on
**capability flags**, which can change for a single connection; for example, Depop runs
assisted until its partner API is connected, then through the API.

```ts
type Mode = 'api' | 'automation' | 'assisted' | 'bulk_file' | 'none';
interface MarketplaceCapabilities {
  connect: 'oauth' | 'session' | 'none'; // session: the seller logs in, Listora keeps the cookies
  create: Mode;
  updatePrice: Mode;
  updateDetails: Mode;
  delist: Mode;
  relist: Mode;
  markSold: Mode | 'not_needed'; // not_needed: the marketplace marks its own sales sold
  verifyRead: 'api' | 'automation' | 'user_confirm'; // how success is established
  readFreshness: 'revision' | 'none'; // whether reads carry a revision (see operations.md)
  title: 'field' | 'none'; // Depop: none (listings have no title; read-backs never check one)
  importListings: 'api' | 'share_sheet' | 'bulk_file' | 'none';
  saleDetection: Array<'webhook' | 'poll' | 'email' | 'manual'>;
  imageTransport: 'url_fetch' | 'upload' | 'user_saves_photos';
  taxonomy: 'api' | 'static_snapshot';
  pricingData: 'sold_comps_in_listing_context' | 'none';
  externalSkuReusable: boolean; // Depop: false
  limits: { perSellerPerMin?: number; appPerMin?: number; appPerDay?: number };
}
interface MarketplaceAdapter<P extends ListingPayload = ListingPayload> {
  id: 'ebay' | 'depop' | 'poshmark' | 'mercari';
  capabilities(connection?: ConnectionRef | null): MarketplaceCapabilities;
  buildPayload(item: ItemSnapshot, variant: ListingVariant, connection: ConnectionRef | null): P; // pure
  validate(payload: P, connection: ConnectionRef | null): ValidationIssue[]; // pure
  execute(op: OperationRequest<P>, ctx: AdapterContext): Promise<Outcome>;
  // Outcome: confirmed | rejected | transient | unknown | pendingUser
  readListing(ref: ListingRef, ctx: AdapterContext): Promise<RemoteListingState>;
  healthCheck(ctx: AdapterContext): Promise<Health>; // ok | degraded | reauth_required | revoked
  newListingId?(
    item: ItemSnapshot,
    usedIds: readonly string[],
    connection: ConnectionRef | null,
  ): string | null;
  listOrdersSince?(since: Date | null, ctx: AdapterContext): Promise<RemoteOrder[]>; // sale checks
}
```

Imports and emails join the interface as optional members with the tasks that first use them
(T-23, T-36); orders joined with the browser runner's sale checks
([automation.md](automation.md), `listOrdersSince`). eBay's notifications and order sync follow
eBay's own contracts and live in `@listora/sales`, outside the interface
([ebay-notifications.md](ebay-notifications.md)). A `ConnectionRef` names the connection's
`mode` and `status`. Credentials are not part of the interface: an adapter gets a connection's
tokens or browser session at use time from its own source (eBay's `EbaySellerSource`, which
`@listora/connections` implements over the token vault, [connections.md](connections.md); the
browser runner's session vault).

| Marketplace | Mode                                                                         | Listing lifecycle                                                                                                                          | Sale detection                                                  |
| ----------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| eBay        | API                                                                          | Trading API Add/Revise/End/Relist (keeps listings editable in Seller Hub); Media, Taxonomy, Fulfillment REST APIs                          | `ORDER_CONFIRMATION` webhook + 5-minute poll                    |
| Depop       | API after partner approval; browser automation until then, assisted fallback | `PUT` by a SKU Listora names per listing (`AJ-000184-D1`, `-D2` after a relist), `PATCH`, `DELETE`/mark-as-sold; verify with `GET`         | `v1:order.*` webhooks (`X-Depop-Signature`) + orders poll       |
| Poshmark    | Browser automation (permitted by Poshmark), assisted fallback                | The runner acts in the seller's session and reads the listing back; fallback: copy-assist, photos saved in order, deep link, user confirms | DKIM-verified forwarded emails, scheduled browser check, manual |
| Mercari     | Browser automation (permitted; no public API), assisted fallback             | Same as Poshmark                                                                                                                           | Forwarded emails, scheduled browser check, manual               |

**Capabilities route every operation.** `operationMode(capabilities, kind)` (`capabilities.ts`)
reads the flag for the kind (`create`, `updateDetails` for a revise, `updatePrice`, `delist` for
an end, `relist`, `markSold`) under the listing's connection: `api` (Listora sends it and a
read-back decides), `automation` (the browser runner does it in the seller's session, and a
read-back through the same session decides), `assisted` (only the user's confirmation finishes
it), or `unsupported` (`none`, `bulk_file`, `not_needed`, or a write without reads through its
own channel), which fails without being sent. `checkCapabilities` rejects contradictory flags,
such as an API write with `verifyRead: 'user_confirm'`, an automated write with
`verifyRead: 'api'`, or automated reads without `connect: 'session'`.

**Titles.** `readBackState(desired, capabilities)` is the part of a desired state a read-back
can show: on a marketplace whose listings have no title (`title: 'none'`, Depop) the engine and
the conformance suite never compare one. The variant's title stays Listora's own headline there.

**Listings Listora names.** An adapter whose marketplace addresses listings by an id the seller's
tool chooses (Depop's SKUs) implements `newListingId`. Before a create or relist is sent, in
the transaction that marks the step `running`, the engine names the new listing with it, stores
the id as the listing's pending id, and records it in the `running` event (`namedListingId`), so
a read-back finds the listing even when the send's answer is lost. The id passes `usedIds`
(every id the item has had on the marketplace, from its listings and their operations'
history), so no name is given twice. An operation keeps its name on every attempt and Retry; a
listing that already has a pending id keeps it (an earlier create or relist may have made that
listing); a create names only a listing with no marketplace listing yet, a relist only one that
has one. When the send that named an id was refused or never made, the listing forgets the
pending id, so a delist never waits on a listing that was never made.

**Registry.** `createAdapterRegistry` (`registry.ts`) holds one adapter per marketplace and
refuses, at startup, a duplicate or an adapter whose capabilities are incoherent without a
connection or under any mode and status of connection. `createMarketplaceAdapters`
(`default-adapters.ts`) builds the registry every process runs with: the worker and the browser
runner pass its `lookup` to the engine (with the same automation adapters, its `automation`
setting, so both route each operation to the same mode), and the API asks it for capabilities
under a connection.

**Listing content and payloads.** A create, revise, or relist publishes listing content
(`content.ts`): an `ItemSnapshot` (canonical attributes and photos with their listing URLs) and
the marketplace's `ListingVariant` (title, description, price, category, condition, aspects,
hashtags), mirroring the API contract. `enqueueOperation` stores it on the operation and derives
the operation's desired state from it (`desiredStateForContent`), so what is sent and what a
read-back checks cannot disagree. Every attempt builds the payload from that stored content
with the adapter's pure `buildPayload`, under the connection it runs with, so a queued item edit
never changes an operation in flight. The engine sends nothing the adapter's `validate` refuses:
the operation fails with the first issue's message (for example "eBay titles can be at most 80
characters.") and every issue in its history. Builders sort photos by `position` and never trust
the input order. Each adapter's payload, validation results, and assisted tasks are pinned by
golden files in its `__golden__` directory; `npx vitest -u` rewrites them after a deliberate
change, and the diff is reviewed like code.

**Execute and read-back rules.** `execute` never throws for a marketplace error; it returns an
outcome. A rate limit is `transient` with the marketplace's `Retry-After`, a 5xx is `transient`
(even when it hid an applied write, which the next attempt's read-back finds), validation and
expired authorization (`reauth_required`) are `rejected`, a timeout after sending is `unknown`,
and ending an ended listing is `confirmed` so that a read-back decides. `readListing` throws when
the marketplace cannot be read (5xx, 429, auth error, unreachable), and must find the effect of
an earlier attempt even when that attempt's outcome was unknown (by external id or SKU).
When it finds no listing, it says whether that is `authoritative`: only when the marketplace
definitively reports that the listing with the requested id no longer exists (a "removed" or
410 Gone answer for that id), never for an answer that could be a listing not visible yet (a
plain 404 from an eventually consistent API), an empty SKU search, a timeout, an auth error, or
another unclear answer.

Reads may be stale (eventually consistent APIs), so a read carries a freshness marker: a
`revision`, a non-negative integer that grows with every change to the marketplace listing (a
remote revision, or a last-modified time in milliseconds that differs for every change). A
`confirmed` outcome also returns the revision the write produced, when the marketplace says. An
adapter whose marketplace has no such marker declares `readFreshness: 'none'` and returns
`revision: null`.

**Assisted adapters.** `AssistedAdapter` (`assisted/assisted-adapter.ts`) is the base for assisted
mode. `createPoshmarkAdapter`, `createMercariAdapter`, and `createDepopAssistedAdapter` configure
it: those marketplaces run on it until the browser runner (decision D1,
[automation.md](automation.md)) or Depop's partner API takes over, and it stays their fallback when
automation meets a check it must not pass. `execute` never contacts the marketplace: it returns
`pendingUser` with a user task, `list_manually` (create, relist), `edit_manually` (revise, price),
or `delist_manually` (end), with a deep link and a copy-assist payload (title, description, price,
and photo URLs in posting order). The engine records the task in the same transaction as the
`needs_user_action` status, and only `confirmOperationByUser` can finish the operation. Assisted
capabilities establish success by `user_confirm`, `readListing` always throws, and the engine never
reads back an assisted operation, so no read can ever confirm one. New listings open the
marketplace's site; changes open the listing's own page once the user has linked it, and only when
that URL is an https page on the marketplace's own domain. Deeper app links and the Poshmark and
Mercari text limits are not verified yet (plan RF15), so the base enforces only a positive price and
at least one photo for them.

**Connection-aware capabilities.** `ConnectionAwareAdapter` serves one marketplace in more than
one mode: its assisted adapter without a connection or under an assisted one, its API adapter
under an `api` connection, and its automation adapter under an `automation` connection whose
session works (`connected` or `degraded`). Each falls back to assisted when no adapter is
configured for the mode, and an automation connection that waits for a relink is served
assisted. Every mode reads and writes the same `marketplace_listing` rows, so switching a
marketplace between modes is a change to the connection and needs no data migration.

**Conformance.** Every adapter passes the shared suite in `conformance/suite.ts`
(`describeAdapterConformance`), once per connection mode it serves, against its own fake
marketplace: coherent capabilities, pure golden-tested payloads and validation, create, price
and detail updates, end (twice), relist, mark sold, read-back by SKU and id with freshness,
stale reads, not-found classification, error mapping (429 with and without `Retry-After`, 5xx
before and after the change, validation, expired authorization, timeout after send,
unreachable), failing reads that throw, health checks, and, for assisted kinds, user tasks that
never touch the network and never confirm themselves. A new marketplace fake must be able to
produce each failure mode the suite asks for (`ConformanceMarketplace`).

## Listings in the API (`apps/api/src/listings`)

- **Listings.** An item's `listings` (and `ItemSummary.listings`) are its newest listing per
  marketplace, each with a server-rendered `statusDisplay` (`listings/views.ts`). A listing is
  `api` only while it is on an API connection, `automation` only while it is on an automation
  connection whose session works, otherwise `assisted`. Only an API or automated listing can be
  verified by a read-back (`last_verified_at`, "confirmed by eBay") and only an assisted one by
  the user (`user_confirmed_at`, "you confirmed"), so an assisted listing can never claim the
  marketplace confirmed it.
- **Shared-listing links.** `linkItemListing` and `importSharedListing` record a listing the
  user created on a marketplace and shared from Safari or the marketplace app to the Share
  Extension. The server reads the marketplace and listing id from the URL with
  `parseListingUrl` (`@listora/shared`; the iOS `ListingURL` parser is tested against the same
  fixtures in `packages/shared/fixtures/listing-urls.json`) and never fetches it. The listing is
  assisted, `active`, and user-confirmed; a short link (`posh.mk/...`) has no listing id and is
  identified by its URL.

## Data

- **Marketplaces:** `marketplace_connection` and `connection_authorization`
  ([connections.md](connections.md#data)),
  `marketplace_listing` (per-marketplace variant, external ids, status, remote snapshot and
  newest seen revision, desired/applied version, `last_verified_at` for a read-back and
  `user_confirmed_at` for the user's confirmation; a listing known only by a share short link
  is unique by its URL), `marketplace_operation` (with the listing `content` a create, revise,
  or relist publishes), and the append-only `operation_event`.
