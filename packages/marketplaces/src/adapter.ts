/**
 * The marketplace adapter interface (docs/architecture.md section 4). All marketplace logic
 * lives behind it; the operation engine and the UI never branch on the marketplace name.
 *
 * This is the minimal interface the operation engine needs (T-06). The adapter framework
 * (T-10) adds the rest of the planned interface (`buildPayload`, `validate`, `healthCheck`,
 * and the optional import, order, webhook, email, and credential members) without changing
 * these members.
 */
import type {
  ConnectionMode,
  JsonObject,
  Marketplace,
  OperationKind,
  UserTaskKind,
} from '@listora/db';
import type { CurrencyCode } from '@listora/shared';

/** How a marketplace supports a capability. */
export type Mode = 'api' | 'assisted' | 'bulk_file' | 'none';

/** Capability flags; they may change for one connection (Depop: assisted until approved). */
export interface MarketplaceCapabilities {
  connect: 'oauth' | 'none';
  create: Mode;
  updatePrice: Mode;
  updateDetails: Mode;
  delist: Mode;
  relist: Mode;
  markSold: Mode | 'not_needed';
  /** How success is established: an API read-back, or the user's confirmation. */
  verifyRead: 'api' | 'user_confirm';
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
}

/** The connection an operation runs under, without credentials (T-16 adds token access). */
export interface ConnectionRef {
  id: string;
  mode: ConnectionMode;
}

export interface AdapterContext {
  /** Aborted when the engine's deadline for the call passes or the worker shuts down. */
  signal: AbortSignal;
  connection: ConnectionRef | null;
}

/** One attempt of a marketplace operation. */
export interface OperationRequest {
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
}

/** A listing as read back from the marketplace, normalized to Listora's fields. */
export type RemoteListingState =
  | { found: false }
  | {
      found: true;
      externalListingId: string;
      externalUrl: string | null;
      status: RemoteListingStatus;
      title: string | null;
      description: string | null;
      priceCents: number | null;
      currency: CurrencyCode | null;
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
 * What happened when an adapter executed one attempt (docs/architecture.md section 6). Codes
 * are stable machine-readable identifiers; messages are user-readable and name the marketplace.
 */
export type Outcome =
  /** The marketplace accepted the write. The engine still reads the listing back to verify. */
  | { type: 'confirmed'; externalListingId?: string; excerpt?: Excerpt }
  /** Validation or another permanent error: retrying the same request cannot succeed. */
  | { type: 'rejected'; code: string; message: string; fixHint?: string; excerpt?: Excerpt }
  /** A temporary failure (429, 5xx, network failure before sending). Safe to try again. */
  | { type: 'transient'; code: string; message: string; retryAfterMs?: number; excerpt?: Excerpt }
  /** The request may have reached the marketplace (for example a timeout after sending). */
  | { type: 'unknown'; code: string; message: string; excerpt?: Excerpt }
  /** Assisted mode: the user has to do the step, then confirm it. */
  | { type: 'pendingUser'; task: UserTaskSpec; excerpt?: Excerpt };

export interface MarketplaceAdapter {
  readonly id: Marketplace;
  capabilities(connection?: ConnectionRef): MarketplaceCapabilities;
  /** Sends one attempt. Must not throw for marketplace errors; it returns an `Outcome`. */
  execute(op: OperationRequest, ctx: AdapterContext): Promise<Outcome>;
  /**
   * Reads the listing back. Must observe the effect of any earlier attempt of an operation on
   * this listing, including one whose outcome was unknown (find it by external SKU or id).
   * Throws when the marketplace cannot be read.
   */
  readListing(ref: ListingRef, ctx: AdapterContext): Promise<RemoteListingState>;
}

/** Finds the adapter for a marketplace; `undefined` when Listora has none configured. */
export type AdapterLookup = (marketplace: Marketplace) => MarketplaceAdapter | undefined;
