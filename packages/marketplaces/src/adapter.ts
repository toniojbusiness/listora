/**
 * The marketplace adapter interface (docs/features/marketplaces.md). All marketplace logic
 * lives behind it; the operation engine and the UI never branch on the marketplace name, only
 * on capability flags (capabilities.ts), which may differ per connection.
 *
 * Every adapter follows the same pattern:
 *
 * - `buildPayload` and `validate` are pure: the same listing content and connection always
 *   give the same payload and issues, and golden tests pin both down. The engine builds and
 *   validates the payload of every attempt itself and never sends an invalid one.
 * - `execute` sends one attempt and maps every answer onto an `Outcome`; it never throws for a
 *   marketplace error.
 * - `readListing` reports what the marketplace shows, with a freshness marker, and says when an
 *   absence is definitive.
 * - The shared conformance suite (conformance/suite.ts) checks each of these rules against the
 *   adapter's own fake marketplace.
 *
 * Imports, webhooks, and emails join this interface with the tasks that first use them (T-17,
 * T-23, T-36), as optional members; orders joined with the browser runner's sale checks
 * (`listOrdersSince`), the seller's listings with the Poshmark and Mercari automation adapters
 * (`listListings`, a page at a time with what an import needs, docs/features/imports.md), an
 * order's fees with the sale lifecycle (`readOrderFees`, T-26), and an order's shipping label
 * with Pack check (`readOrderLabels`). Credentials are not members: an adapter gets
 * a connection's tokens or browser session at use time from its own source (eBay's
 * `EbaySellerSource`, which `@listora/connections` implements over the token vault; the browser
 * runner's session vault).
 */
import type {
  ConnectionMode,
  ConnectionStatus,
  FeeKind,
  JsonObject,
  Marketplace,
  OperationKind,
  UserTaskKind,
} from '@listora/db';
import type { CurrencyCode } from '@listora/shared';

import type { ItemCondition, ItemSnapshot, ListingVariant } from './content.ts';
import type {
  OfferAnswerOutcome,
  OfferAnswerRequest,
  OfferRef,
  RemoteOffer,
  RemoteOfferState,
} from './offers.ts';

/**
 * How a marketplace supports a capability: through its official API, by browser automation in
 * the seller's own session (decision D1, `automation`), by the user (`assisted`), by a bulk file,
 * or not at all. `api` and `automation` writes are confirmed only by a read-back through the same
 * channel; `assisted` ones only by the user.
 */
export type Mode = 'api' | 'automation' | 'assisted' | 'bulk_file' | 'none';

/**
 * Capability flags; they may change for one connection (Depop: assisted until approved). The
 * engine reads `create` through `markSold` to route each kind of operation (`operationMode`),
 * and `verifyRead` and `readFreshness` to decide how success is established.
 */
export interface MarketplaceCapabilities {
  /** `session`: the seller logs into the marketplace in the app, and Listora keeps the cookies. */
  connect: 'oauth' | 'session' | 'none';
  create: Mode;
  updatePrice: Mode;
  updateDetails: Mode;
  delist: Mode;
  relist: Mode;
  /** `not_needed`: the marketplace marks its own sales sold; Listora never asks. */
  markSold: Mode | 'not_needed';
  /**
   * How success is established: a read-back through the API, a read-back through the automated
   * browser session, or the user's confirmation.
   */
  verifyRead: 'api' | 'automation' | 'user_confirm';
  /**
   * How a read-back shows it is current. `revision`: every read carries the listing's
   * `revision`. `none`: the marketplace has no such marker, so the engine confirms a change only
   * after two matching reads separated by a delay.
   */
  readFreshness: 'revision' | 'none';
  /**
   * Whether listings have a title of their own. `none` (Depop): the description is the whole
   * listing text, so reads show no title and a read-back never checks one (`readBackState`).
   */
  title: 'field' | 'none';
  importListings: 'api' | 'share_sheet' | 'bulk_file' | 'none';
  saleDetection: ('webhook' | 'poll' | 'email' | 'manual')[];
  imageTransport: 'url_fetch' | 'upload' | 'user_saves_photos';
  taxonomy: 'api' | 'static_snapshot';
  pricingData: 'sold_comps_in_listing_context' | 'none';
  /** Whether an external SKU may be used again after its listing ends (Depop: no). */
  externalSkuReusable: boolean;
  limits: { perSellerPerMin?: number; appPerMin?: number; appPerDay?: number };
}

/** Display names for user-facing messages. */
export const MARKETPLACE_NAMES = {
  ebay: 'eBay',
  depop: 'Depop',
  poshmark: 'Poshmark',
  mercari: 'Mercari',
} as const satisfies Record<Marketplace, string>;

export function isMarketplace(value: string): value is Marketplace {
  return Object.hasOwn(MARKETPLACE_NAMES, value);
}

/** The listing states every adapter maps its marketplace's own statuses onto. */
export const REMOTE_LISTING_STATUSES = ['active', 'ended', 'sold'] as const;
export type RemoteListingStatus = (typeof REMOTE_LISTING_STATUSES)[number];

/**
 * The listing state an operation asks the marketplace to hold (`marketplace_operation.desired`).
 * Only the fields present are part of the change, and a read-back confirms the operation only
 * when every present field matches.
 */
export interface DesiredListingState {
  status?: RemoteListingStatus;
  title?: string;
  description?: string;
  priceCents?: number;
  currency?: CurrencyCode;
}

/** Operation kinds that write to the marketplace; `verify` only reads the listing back. */
export type WriteOperationKind = Exclude<OperationKind, 'verify'>;

/** Identifies a listing on the marketplace (from `marketplace_listing`). */
export interface ListingRef {
  /** Listora's `marketplace_listing.id`. */
  listingId: string;
  /** The marketplace's id for the listing, once known. */
  externalListingId: string | null;
  /** The seller SKU sent to the marketplace, when the adapter uses one. */
  externalSku: string | null;
  /** The listing's page on the marketplace, once known (assisted tasks link to it). */
  externalUrl: string | null;
}

/** The connection an operation runs under, without credentials (adapters fetch those at use time). */
export interface ConnectionRef {
  id: string;
  /**
   * `api` once the seller connected an official API, `automation` once they linked a browser
   * session; capabilities follow it.
   */
  mode: ConnectionMode;
  /**
   * An automation connection waiting to be relinked (`reauth_required`, `revoked`) holds no
   * session, so its marketplace is served assisted until the seller logs in again.
   */
  status: ConnectionStatus;
}

export interface AdapterContext {
  /** Aborted when the engine's deadline for the call passes or the worker shuts down. */
  signal: AbortSignal;
  connection: ConnectionRef | null;
  /** The operation the call is a step of, when it is one (for the adapter's own records). */
  operationId?: string;
}

/**
 * What an adapter sends for a create, revise, or relist, in the marketplace's own terms. It is
 * JSON so it can be compared with golden files, and it never holds credentials.
 */
export type ListingPayload = JsonObject;

/** A reason a listing can't be sent to a marketplace as it is. */
export interface ValidationIssue {
  /**
   * The listing content field the user has to change, as a path: `variant.title`,
   * `variant.price`, `item.photos`, and so on.
   */
  field: string;
  /** Stable machine-readable reason: `required`, `too_long`, `too_many`, `out_of_range`, ... */
  code: string;
  /** User-readable and names the marketplace, for example "eBay titles can be at most 80 characters." */
  message: string;
}

/** One attempt of a marketplace operation. */
export interface OperationRequest<P extends ListingPayload = ListingPayload> {
  operationId: string;
  kind: WriteOperationKind;
  /**
   * The same for every attempt of the operation. An adapter passes it to the marketplace's
   * duplicate protection where one exists (eBay `Item.UUID`, a Depop per-attempt SKU), so a
   * write that is sent again after an unknown outcome is applied once.
   */
  idempotencyKey: string;
  /** 1 for the first attempt. */
  attempt: number;
  /**
   * Whether an earlier attempt of the operation may have reached the marketplace, as the engine
   * reads the operation's history: an attempt whose recorded result shows it changed nothing
   * (refused, or stopped before any step that changes the listing) did not. A create or relist
   * that may have posted before looks for that listing first, so it never posts a second copy;
   * one that knows nothing was posted goes straight to posting. Absent (a caller that does not
   * know), every attempt after the first may have.
   */
  mayHaveApplied?: boolean;
  desired: DesiredListingState;
  listing: ListingRef;
  /**
   * For a create, revise, or relist: this adapter's `buildPayload` result for the operation's
   * content under the same connection, already validated. `null` for every other kind.
   */
  payload: P | null;
}

/** A listing as read back from the marketplace, normalized to Listora's fields. */
export type RemoteListingState =
  /**
   * No listing found. `authoritative` only when the marketplace definitively says the listing
   * with the requested id no longer exists (for example a "removed" or 410 Gone answer for that
   * id), never for an answer that could be a listing not visible yet (a plain 404 from an
   * eventually consistent API), a search that came back empty, a timeout, an auth error, or any
   * other unclear answer. An end or mark-sold counts an authoritative absence as "cannot be live".
   */
  | { found: false; authoritative: boolean }
  | {
      found: true;
      externalListingId: string;
      externalUrl: string | null;
      status: RemoteListingStatus;
      title: string | null;
      description: string | null;
      priceCents: number | null;
      currency: CurrencyCode | null;
      /**
       * A non-negative integer that grows with every change to the listing (a remote revision,
       * or a last-modified time in milliseconds that differs for every change), so a stale read
       * can be told from a current one. Required when `readFreshness` is `revision`, else `null`.
       */
      revision: number | null;
    };

/**
 * A short request/response excerpt for the operation history. The engine redacts it before
 * storing it, but adapters still never put tokens, credentials, or full payloads in it.
 */
export type Excerpt = JsonObject;

/** The user task an assisted adapter asks for (deep link plus copy-assist payload). */
export interface UserTaskSpec {
  kind: UserTaskKind;
  deepLink: string | null;
  payload: JsonObject;
}

/**
 * What happened when an adapter executed one attempt (docs/features/operations.md). Codes
 * are stable machine-readable identifiers; messages are user-readable and name the marketplace.
 */
export type Outcome =
  /**
   * The marketplace accepted the write. The engine still reads the listing back to verify.
   * `revision` is the listing's revision after the write, when the marketplace returns it.
   */
  | { type: 'confirmed'; externalListingId?: string; revision?: number; excerpt?: Excerpt }
  /** Validation or another permanent error: retrying the same request cannot succeed. */
  | { type: 'rejected'; code: string; message: string; fixHint?: string; excerpt?: Excerpt }
  /** A temporary failure (429, 5xx, network failure before sending). Safe to try again. */
  | { type: 'transient'; code: string; message: string; retryAfterMs?: number; excerpt?: Excerpt }
  /** The request may have reached the marketplace (for example a timeout after sending). */
  | { type: 'unknown'; code: string; message: string; excerpt?: Excerpt }
  /**
   * Assisted mode: the user has to do the step, then confirm it. The engine accepts it only for
   * an operation whose capability mode is `assisted`.
   */
  | { type: 'pendingUser'; task: UserTaskSpec; excerpt?: Excerpt };

/**
 * A connection's health as one cheap marketplace call shows it (the daily health job, T-25).
 * `ok` also means "nothing to check" for an assisted marketplace.
 */
export type Health =
  | { status: 'ok' }
  | {
      status: Exclude<ConnectionStatus, 'connected'>;
      /** Stable machine-readable reason, for example `unreachable` or `rate_limited`. */
      code: string;
      /** User-readable and names the marketplace. */
      message: string;
    };

/** One fee the marketplace charged the seller on an order, as `readOrderFees` reports it. */
export interface OrderFee {
  kind: FeeKind;
  /** What the marketplace calls it, for example "Final value fee". */
  description: string;
  /** Positive for a fee the seller pays, negative for a refunded fee. Never zero. */
  amountCents: number;
  currency: CurrencyCode;
}

/** What the marketplace reports of an order's fees. Never thrown: every answer is one of these. */
export type OrderFeesResult =
  /** Every fee the marketplace charged on the order, so far. */
  | { type: 'fees'; fees: OrderFee[] }
  /** The marketplace does not report the order's fees yet; ask again later. */
  | { type: 'not_yet' }
  /** A temporary failure (429, 5xx, network); ask again later. */
  | { type: 'transient'; code: string; message: string; retryAfterMs?: number }
  /**
   * The marketplace won't report them (the connection lacks access, an unknown order, an amount
   * in another currency); the sale keeps its estimated fees.
   */
  | { type: 'unavailable'; code: string; message: string };

export interface MarketplaceAdapter<P extends ListingPayload = ListingPayload> {
  readonly id: Marketplace;
  /**
   * The capabilities under a connection; without one, the marketplace's default (Depop:
   * assisted). A connection that switches to `api` switches them without any data migration.
   */
  capabilities(connection?: ConnectionRef | null): MarketplaceCapabilities;
  /**
   * Builds the marketplace payload for a listing's content. Pure: no I/O, no clock, no
   * randomness, and the inputs are never changed. Photos go in `position` order.
   */
  buildPayload(item: ItemSnapshot, variant: ListingVariant, connection: ConnectionRef | null): P;
  /**
   * The marketplace's rules for a payload `buildPayload` returned (length limits, required
   * photos, price range); empty when it can be sent. Pure.
   */
  validate(payload: P, connection: ConnectionRef | null): ValidationIssue[];
  /** Sends one attempt. Must not throw for marketplace errors; it returns an `Outcome`. */
  execute(op: OperationRequest<P>, ctx: AdapterContext): Promise<Outcome>;
  /**
   * Reads the listing back. Must observe the effect of any earlier attempt of an operation on
   * this listing, including one whose outcome was unknown (find it by external SKU or id).
   * A read may be stale; its `revision` (see `readFreshness`) lets the engine tell.
   * Throws when the marketplace cannot be read; an assisted adapter always throws.
   */
  readListing(ref: ListingRef, ctx: AdapterContext): Promise<RemoteListingState>;
  /** One cheap call that shows whether the connection works. Never throws. */
  healthCheck(ctx: AdapterContext): Promise<Health>;
  /**
   * For a marketplace whose listings Listora names itself (Depop: a product is created and
   * addressed by the SKU Listora sends, and a SKU is never used twice): the id the next create
   * or relist of this item gives its new listing. `usedIds` holds every id the item has had on
   * the marketplace. The engine stores the id on the listing before it sends anything, so a
   * read-back finds the listing even when the send's answer is lost. `null`, or no such member:
   * the marketplace names its listings itself and the send returns the id. Pure.
   */
  newListingId?(
    item: ItemSnapshot,
    usedIds: readonly string[],
    connection: ConnectionRef | null,
  ): string | null;
  /**
   * The fees the marketplace charged on one of the seller's orders (eBay: the Finances API;
   * Depop: the order's fee breakdown), under `ctx.connection`, so a sale's estimated fee lines
   * can be replaced by the actual ones. No such member: the marketplace doesn't report fees, and
   * sales keep the fee table's estimate.
   */
  readOrderFees?(externalOrderId: string, ctx: AdapterContext): Promise<OrderFeesResult>;
  /**
   * The seller's orders sold at or after `since`, for a scheduled sale check; with `null`, the
   * seller's sales history: every order the marketplace's sold pages show, up to the adapter's
   * history limit. Only adapters that can read orders have it. Throws when the marketplace
   * cannot be read, like `readListing`; an empty list means it showed no order.
   */
  listOrdersSince?(since: Date | null, ctx: AdapterContext): Promise<RemoteOrder[]>;
  /**
   * One page of the seller's listings for sale on the marketplace, newest first, each with what
   * an import needs (`ListedListing`): the first page for a `null` cursor, the next one for the
   * `next` a page returned. Only reads. Only adapters that can list them have it. Throws when
   * the marketplace cannot be read.
   */
  listListings?(cursor: string | null, ctx: AdapterContext): Promise<ListingsPage>;
  /**
   * The shipping labels of the seller's orders, from each order's own page, for Pack check
   * (docs/features/pack-check.md): its tracking number and the buyer's first name. Only reads.
   * Only adapters that can read order pages have it. Throws when the marketplace cannot be
   * read; an order the pages don't show is `found: false`.
   */
  readOrderLabels?(
    orders: readonly LabelReadRequest[],
    ctx: AdapterContext,
  ): Promise<RemoteOrderLabel[]>;
  /**
   * The offers buyers made on the seller's listings that the marketplace shows as open
   * (docs/features/offers.md). Only reads. Throws when the marketplace cannot be read.
   */
  listOffers?(ctx: AdapterContext): Promise<RemoteOffer[]>;
  /** One offer as the marketplace shows it now: the read-back of an answer. Only reads. */
  readOffer?(ref: OfferRef, ctx: AdapterContext): Promise<RemoteOfferState>;
  /**
   * Sends the seller's answer to an offer, once. Never throws for a marketplace's answer; a
   * `sent` answer is done only once `readOffer` shows it.
   */
  answerOffer?(request: OfferAnswerRequest, ctx: AdapterContext): Promise<OfferAnswerOutcome>;
}

/** An order whose label Pack check reads: its marketplace id and the listings that sold in it. */
export interface LabelReadRequest {
  externalOrderId: string;
  externalListingIds: string[];
}

/**
 * An order's shipping label as its page shows it. Only the buyer's first name: never their full
 * name, address, or messages.
 */
export type RemoteOrderLabel =
  | {
      externalOrderId: string;
      found: true;
      /** As the page shows it; `null` while the order has no label yet. */
      trackingNumber: string | null;
      buyerFirstName: string | null;
      /**
       * How the order stands there, when the page says: waiting for the seller to ship it, or
       * shipped or canceled (delivered and refunded included). Only this says whether the order
       * is a package to pack, never the label's or parcel's own status.
       */
      orderState?: 'to_ship' | 'shipped' | 'canceled';
      /** The label's carrier as the page names it (`USPS`), when it does. */
      carrierName?: string | null;
      /** When the order must ship by, when the page says. */
      shipBy?: Date | null;
      /** When the label stops being usable, when the page says. */
      labelExpiresAt?: Date | null;
    }
  | { externalOrderId: string; found: false };

/** A listing a read found. */
export type RemoteListing = Extract<RemoteListingState, { found: true }>;

/**
 * What a listing shows besides its state, as an import takes it into an item: in the
 * marketplace's own words, except the condition, which is Listora's.
 */
export interface ListingDetails {
  /** Its photos, cover first, as the marketplace's own full-size image URLs (https). */
  photoUrls: string[];
  brand: string | null;
  /** Its size as the listing shows it (`M`, `8`, `32x30`). */
  size: string | null;
  /** The marketplace's condition in Listora's terms; `null` when it shows none Listora knows. */
  condition: ItemCondition | null;
  /** Its category, in the form a listing's `variant.categoryRef` takes on that marketplace. */
  categoryRef: string | null;
  /** Its category's names, top level first (`["Women", "Dresses", "Maxi"]`). */
  categoryPath: string[];
  /** Its colours in Listora's terms (packages/analysis `COLORS`), the ones Listora knows. */
  colors: string[];
  /**
   * The price before the marketplace's markdown, when the listing is marked down (`priceCents`
   * is then the reduced price a buyer pays now); `null` when it is not.
   */
  originalPriceCents: number | null;
  /** The SKU Listora's line at the end of its text names, when it has one (sku-line). */
  sku: string | null;
}

/** One of the seller's listings, as an import reads it. */
export type ListedListing = RemoteListing & { details: ListingDetails };

/** One page of the seller's listings, newest first. */
export interface ListingsPage {
  listings: ListedListing[];
  /** The cursor of the next page; `null` after the last one. */
  next: string | null;
}

/** One item of a marketplace order, as a sale check reads it. */
export interface RemoteOrderItem {
  /** The marketplace's id of the listing that sold, when the order shows it. */
  externalListingId: string | null;
  title: string | null;
  priceCents: number;
  currency: CurrencyCode;
  /**
   * The sold listing as the marketplace's pages show it (status `sold`), with its photos and
   * details, when they show it: a sale of a listing Listora doesn't have becomes a sold item
   * from it (docs/features/sales.md, "Sales history").
   */
  listing?: ListedListing;
}

/**
 * A marketplace order found by a sale check, for the sale intake (an `inbound_event`). It holds
 * the order's identity, time, and items only: never the buyer's name, address, or messages.
 */
export interface RemoteOrder {
  externalOrderId: string;
  soldAt: Date;
  items: RemoteOrderItem[];
  /**
   * Whether the marketplace shows the order shipped (or delivered), or still waiting to ship;
   * absent when its pages don't say.
   */
  shipped?: boolean;
  /**
   * The fees the marketplace took on the order as its pages show them (Depop's receipt: what
   * the items sold for less what the seller is paid), which replace the estimate; absent when
   * its pages don't show them.
   */
  fees?: OrderFee[];
}

/** Finds the adapter for a marketplace; `undefined` when Listora has none configured. */
export type AdapterLookup = (marketplace: Marketplace) => MarketplaceAdapter | undefined;
