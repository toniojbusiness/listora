/**
 * A `MarketplaceAdapter` for the fake marketplace (fake-marketplace.ts). It speaks the fake's
 * HTTP API and maps its responses and failures onto outcomes exactly as the real adapters do,
 * so the operation engine can be tested against every failure mode without a credential.
 */
import type { Marketplace } from '@listora/db';
import { assertNever, type CurrencyCode } from '@listora/shared';

import {
  MARKETPLACE_NAMES,
  type AdapterContext,
  type Excerpt,
  type ListingRef,
  type MarketplaceAdapter,
  type MarketplaceCapabilities,
  type OperationRequest,
  type Outcome,
  type RemoteListingState,
  type RemoteListingStatus,
} from '../adapter.ts';
import { requestJson, type HttpResult, type JsonRequest } from '../http.ts';

export interface FakeAdapterOptions {
  marketplace: Marketplace;
  /** The fake marketplace's base URL (`FAKE_MARKETPLACE_URL`). */
  baseUrl: string;
  /** Per-request timeout; a timeout after sending is an `unknown` outcome. Default 10 s. */
  requestTimeoutMs?: number;
  /**
   * `api` (default) writes through the API and is verified by read-back. `assisted` behaves
   * like Poshmark: every write becomes a user task, confirmed by the user.
   */
  mode?: 'api' | 'assisted';
  /**
   * `revision` (default) reports the fake's listing revisions. `none` hides them, like a
   * marketplace whose reads carry no freshness marker.
   */
  readFreshness?: MarketplaceCapabilities['readFreshness'];
}

const API_CAPABILITIES: MarketplaceCapabilities = {
  connect: 'oauth',
  create: 'api',
  updatePrice: 'api',
  updateDetails: 'api',
  delist: 'api',
  relist: 'api',
  markSold: 'api',
  verifyRead: 'api',
  readFreshness: 'revision',
  importListings: 'api',
  saleDetection: ['poll'],
  imageTransport: 'url_fetch',
  taxonomy: 'static_snapshot',
  pricingData: 'none',
  externalSkuReusable: true,
  limits: {},
};

const ASSISTED_CAPABILITIES: MarketplaceCapabilities = {
  connect: 'none',
  create: 'assisted',
  updatePrice: 'assisted',
  updateDetails: 'assisted',
  delist: 'assisted',
  relist: 'assisted',
  markSold: 'not_needed',
  verifyRead: 'user_confirm',
  readFreshness: 'none',
  importListings: 'share_sheet',
  saleDetection: ['email', 'manual'],
  imageTransport: 'user_saves_photos',
  taxonomy: 'static_snapshot',
  pricingData: 'none',
  externalSkuReusable: true,
  limits: {},
};

interface FakeListingBody {
  id: string;
  url: string;
  status: RemoteListingStatus;
  title: string;
  description: string;
  priceCents: number;
  currency: CurrencyCode;
  revision: number;
}

export class FakeMarketplaceAdapter implements MarketplaceAdapter {
  readonly id: Marketplace;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #mode: 'api' | 'assisted';
  readonly #capabilities: MarketplaceCapabilities;
  readonly #name: string;

  constructor(options: FakeAdapterOptions) {
    this.id = options.marketplace;
    this.#baseUrl = `${options.baseUrl.replace(/\/+$/, '')}/${options.marketplace}`;
    this.#timeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#mode = options.mode ?? 'api';
    this.#capabilities =
      this.#mode === 'api'
        ? { ...API_CAPABILITIES, readFreshness: options.readFreshness ?? 'revision' }
        : ASSISTED_CAPABILITIES;
    this.#name = MARKETPLACE_NAMES[options.marketplace];
  }

  capabilities(): MarketplaceCapabilities {
    return this.#capabilities;
  }

  async execute(op: OperationRequest, ctx: AdapterContext): Promise<Outcome> {
    if (this.#mode === 'assisted') return this.#assistedTask(op);

    const externalId = op.listing.externalListingId;
    if (op.kind !== 'create' && externalId === null) {
      return {
        type: 'rejected',
        code: 'not_listed',
        message: `This listing isn't on ${this.#name} yet.`,
        fixHint: 'Publish the listing first.',
      };
    }
    const path = (suffix: string): string =>
      `/listings/${encodeURIComponent(externalId ?? '')}${suffix}`;

    switch (op.kind) {
      case 'create':
        return this.#write(ctx, {
          method: 'POST',
          path: '/listings',
          body: { sku: sellerSku(op.listing), ...op.desired },
          idempotencyKey: op.idempotencyKey,
        });
      case 'revise':
      case 'price':
        return this.#write(ctx, { method: 'PATCH', path: path(''), body: listingFields(op) });
      case 'end':
        return this.#write(ctx, { method: 'POST', path: path('/end') });
      case 'relist':
        return this.#write(ctx, { method: 'POST', path: path('/relist') });
      case 'mark_sold':
        return this.#write(ctx, { method: 'POST', path: path('/mark-sold') });
      default:
        return assertNever(op.kind, 'operation kind');
    }
  }

  async readListing(ref: ListingRef, ctx: AdapterContext): Promise<RemoteListingState> {
    const byId = ref.externalListingId !== null;
    const path = byId
      ? `/listings/${encodeURIComponent(ref.externalListingId ?? '')}`
      : `/listings?sku=${encodeURIComponent(sellerSku(ref))}`;
    const result = await this.#send(ctx, { method: 'GET', path });
    if (result.type !== 'response') {
      throw new Error(`${this.#name} could not be read (${result.code})`);
    }
    // Only a removed listing is definitely gone; a 404 may be a listing not visible yet.
    if (byId && result.status === 410) return { found: false, authoritative: true };
    if (byId && result.status === 404) return { found: false, authoritative: false };
    if (result.status !== 200) {
      throw new Error(`${this.#name} could not be read (HTTP ${String(result.status)})`);
    }
    const body = result.body as { listing?: FakeListingBody; listings?: FakeListingBody[] };
    // A SKU should match at most one listing; the newest wins if a duplicate ever exists.
    const listing = byId ? body.listing : body.listings?.at(-1);
    if (listing === undefined) return { found: false, authoritative: false };
    return {
      found: true,
      externalListingId: listing.id,
      externalUrl: listing.url,
      status: listing.status,
      title: listing.title,
      description: listing.description,
      priceCents: listing.priceCents,
      currency: listing.currency,
      revision: this.#revision(listing.revision),
    };
  }

  #assistedTask(op: OperationRequest): Outcome {
    switch (op.kind) {
      case 'create':
      case 'relist':
      case 'end':
      case 'mark_sold':
        return {
          type: 'pendingUser',
          task: {
            kind:
              op.kind === 'create' || op.kind === 'relist' ? 'list_manually' : 'delist_manually',
            deepLink: `${this.#baseUrl}/listings?sku=${encodeURIComponent(sellerSku(op.listing))}`,
            payload: { action: op.kind, ...op.desired },
          },
        };
      case 'revise':
      case 'price':
        return {
          type: 'rejected',
          code: 'not_supported',
          message: `Listora can't change ${this.#name} listings for you yet.`,
          fixHint: `Edit the listing on ${this.#name}.`,
        };
      default:
        return assertNever(op.kind, 'operation kind');
    }
  }

  async #write(
    ctx: AdapterContext,
    request: {
      method: JsonRequest['method'];
      path: string;
      body?: unknown;
      idempotencyKey?: string;
    },
  ): Promise<Outcome> {
    const result = await this.#send(ctx, request);
    const excerpt: Excerpt = {
      request: { method: request.method, path: request.path },
      response: result.type === 'response' ? { status: result.status } : { error: result.code },
    };
    switch (result.type) {
      case 'not_sent':
        return {
          type: 'transient',
          code: 'network_error',
          message: `Listora couldn't reach ${this.#name}.`,
          excerpt,
        };
      case 'maybe_sent':
        return {
          type: 'unknown',
          code: result.code,
          message:
            result.code === 'timeout'
              ? `${this.#name} didn't answer in time.`
              : `The connection to ${this.#name} was lost.`,
          excerpt,
        };
      case 'response':
        return this.#outcomeFor(result, excerpt);
    }
  }

  #outcomeFor(result: Extract<HttpResult, { type: 'response' }>, excerpt: Excerpt): Outcome {
    const { status } = result;
    const error = (result.body as { error?: { code?: string; message?: string } } | null)?.error;
    if (status >= 200 && status < 300) {
      const listing = (result.body as { listing?: { id?: unknown; revision?: unknown } } | null)
        ?.listing;
      const revision = this.#revision(listing?.revision);
      return {
        type: 'confirmed',
        ...(typeof listing?.id === 'string' ? { externalListingId: listing.id } : {}),
        ...(revision === null ? {} : { revision }),
        excerpt,
      };
    }
    // Already in the requested state (for example ending an ended listing): the engine reads
    // the listing back, and only that read decides.
    if (status === 409 && (error?.code === 'already_ended' || error?.code === 'already_sold')) {
      return { type: 'confirmed', excerpt };
    }
    if (status === 429) {
      const retryAfter = Number(result.headers.get('retry-after'));
      return {
        type: 'transient',
        code: 'rate_limited',
        message: `${this.#name} is limiting requests right now.`,
        ...(Number.isFinite(retryAfter) && retryAfter > 0
          ? { retryAfterMs: retryAfter * 1000 }
          : {}),
        excerpt,
      };
    }
    if (status >= 500) {
      return {
        type: 'transient',
        code: 'server_error',
        message: `${this.#name} had a temporary problem.`,
        excerpt,
      };
    }
    if (status === 404 || status === 410) {
      return {
        type: 'rejected',
        code: 'not_found',
        message: `This listing no longer exists on ${this.#name}.`,
        excerpt,
      };
    }
    return {
      type: 'rejected',
      code: error?.code ?? `http_${String(status)}`,
      message: `${this.#name} refused the change: ${error?.message ?? `HTTP ${String(status)}`}.`,
      fixHint: 'Fix the listing details, then retry.',
      excerpt,
    };
  }

  /** A revision from the fake, or `null` when it is missing or this adapter hides revisions. */
  #revision(value: unknown): number | null {
    if (this.#capabilities.readFreshness === 'none') return null;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  #send(
    ctx: AdapterContext,
    request: {
      method: JsonRequest['method'];
      path: string;
      body?: unknown;
      idempotencyKey?: string;
    },
  ): Promise<HttpResult> {
    return requestJson({
      method: request.method,
      url: `${this.#baseUrl}${request.path}`,
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.idempotencyKey === undefined
        ? {}
        : { headers: { 'idempotency-key': request.idempotencyKey } }),
      signal: ctx.signal,
      timeoutMs: this.#timeoutMs,
    });
  }
}

/** The fields a revise or price change sends; the status changes only through end and relist. */
function listingFields(op: OperationRequest): Record<string, unknown> {
  const { title, description, priceCents, currency } = op.desired;
  return Object.fromEntries(
    Object.entries({ title, description, priceCents, currency }).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

/** The seller SKU the fake knows a listing by: the external SKU, else Listora's listing id. */
function sellerSku(ref: ListingRef): string {
  return ref.externalSku ?? ref.listingId;
}
