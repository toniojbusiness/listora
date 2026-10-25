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
 * Imports, orders, webhooks, emails, and credential refresh join this interface with the tasks
 * that first use them (T-16, T-17, T-23, T-36), as optional members.
 */
import type {
  ConnectionMode,
  ConnectionStatus,
  JsonObject,
  Marketplace,
  OperationKind,
  UserTaskKind,
} from '@listora/db';
import type { CurrencyCode } from '@listora/shared';

import type { ItemSnapshot, ListingVariant } from './content.ts';

/** How a marketplace supports a capability. */
export type Mode = 'api' | 'assisted' | 'bulk_file' | 'none';

/**
 * Capability flags; they may change for one connection (Depop: assisted until approved). The
 * engine reads `create` through `markSold` to route each kind of operation (`operationMode`),
 * and `verifyRead` and `readFreshness` to decide how success is established.
 */
export interface MarketplaceCapabilities {
  connect: 'oauth' | 'none';
  create: Mode;
  updatePrice: Mode;
  updateDetails: Mode;
  delist: Mode;
  relist: Mode;
  /** `not_needed`: the marketplace marks its own sales sold; Listora never asks. */
  markSold: Mode | 'not_needed';
  /** How success is established: an API read-back, or the user's confirmation. */
  verifyRead: 'api' | 'user_confirm';
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

/** The connection an operation runs under, without credentials (T-16 adds token access). */
export interface ConnectionRef {
  id: string;
  /** `api` once the seller connected an official API; capabilities follow it. */
  mode: ConnectionMode;
}

export interface AdapterContext {
  /** Aborted when the engine's deadline for the call passes or the worker shuts down. */
  signal: AbortSignal;
  connection: ConnectionRef | null;
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
}

/** Finds the adapter for a marketplace; `undefined` when Listora has none configured. */
export type AdapterLookup = (marketplace: Marketplace) => MarketplaceAdapter | undefined;
