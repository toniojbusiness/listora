/**
 * The Depop adapter (docs/features/depop.md): listings through Depop's Selling API,
 * which Listora uses once its partner access is granted and a seller connects Depop with OAuth.
 * Until then Depop runs assisted, and `ConnectionAwareAdapter` serves this adapter only to
 * connections whose mode is `api`.
 *
 * How it keeps the engine's promises:
 * - **Listings are named by their SKU.** A create or relist is `PUT /api/v1/products/by-sku/
 *   {sku}/` under a SKU Listora names before sending (`newListingId`, sku.ts): `AJ-000184-D1`,
 *   then `-D2` for the relist, since "SKU ... can't be reused" and relisting is a new product.
 *   PUT by SKU creates or updates, so sending a create again after a lost answer applies it
 *   once, and the read-back finds it by that SKU. Edits are `PUT` (the whole listing) or `PATCH`
 *   (the price), an end is `DELETE`, and a sale elsewhere is `mark-as-sold`.
 * - **A success is only ever a read-back's.** DELETE "will return a successful response (200)
 *   even if the product doesn't exist", and mark-as-sold succeeds for a product that isn't on
 *   sale, so their 200 is `confirmed` and the GET read-back decides. A product Depop can't
 *   find is never definitive: "A newly created listing can take a short time to become
 *   retrievable". Reads carry no revision (`updated_at` has whole seconds), so the engine
 *   confirms a change after two matching reads a delay apart (`readFreshness: 'none'`).
 * - **Error mapping.** 429 (with `Retry-After`), 5xx, and network failures before sending are
 *   transient; a timeout after sending is unknown; an invalid token is refreshed and sent once
 *   more (nothing was done), and a refused grant or a missing scope is `reauth_required`; other
 *   refusals are `rejected` with Depop's reason.
 * - **Rate limits.** Every call waits for room in the seller's and the application's allowance
 *   (rate-limits.ts) and is held back, transiently, when there is none soon.
 */
import { assertNever, depopDescription } from '@listora/shared';

import type {
  AdapterContext,
  Excerpt,
  Health,
  ListingRef,
  MarketplaceAdapter,
  MarketplaceCapabilities,
  OperationRequest,
  Outcome,
  RemoteListingState,
  ValidationIssue,
} from '../adapter.ts';
import type { ItemSnapshot, ListingVariant } from '../content.ts';
import { depopErrors, retryAfterMs, type DepopApi, type DepopCallResult } from './client.ts';
import { DepopReauthRequiredError } from './oauth.ts';
import { parseDepopOrdersPage, type DepopOrdersPage } from './orders.ts';
import {
  buildDepopPayload,
  depopAmount,
  depopSizeId,
  validateDepopPayload,
  type DepopListingPayload,
} from './payload.ts';
import { depopProductSchema, depopRemoteListing } from './product.ts';
import type { DepopRateGroup } from './rate-limits.ts';
import { DEPOP_RATE_LIMITS } from './rate-limits.ts';
import type { DepopListingSettings, DepopSellerSource } from './seller.ts';
import { depopProductPath, depopProductRef, nextDepopSku, type DepopProductRef } from './sku.ts';

const NAME = 'Depop';

export interface DepopAdapterOptions {
  api: DepopApi;
  seller: DepopSellerSource;
}

export class DepopAdapter implements MarketplaceAdapter<DepopListingPayload> {
  readonly id = 'depop' as const;
  readonly #api: DepopApi;
  readonly #seller: DepopSellerSource;
  readonly #capabilities: MarketplaceCapabilities = {
    connect: 'oauth',
    create: 'api',
    updatePrice: 'api',
    updateDetails: 'api',
    delist: 'api',
    relist: 'api',
    // "You're expected to call this as soon as you make a sale on a different platform."
    markSold: 'api',
    verifyRead: 'api',
    readFreshness: 'none',
    title: 'none',
    importListings: 'api',
    saleDetection: ['webhook', 'poll'],
    imageTransport: 'url_fetch',
    taxonomy: 'static_snapshot',
    pricingData: 'none',
    externalSkuReusable: false,
    limits: {
      // Creates and full updates: 200 per 10 seconds per seller; everything else 6,000 a minute.
      perSellerPerMin: (DEPOP_RATE_LIMITS.listingWrite.requests * 60_000) / 10_000,
      appPerMin: DEPOP_RATE_LIMITS.application.requests,
    },
  };

  constructor(options: DepopAdapterOptions) {
    this.#api = options.api;
    this.#seller = options.seller;
  }

  capabilities(): MarketplaceCapabilities {
    return this.#capabilities;
  }

  buildPayload(item: ItemSnapshot, variant: ListingVariant): DepopListingPayload {
    return buildDepopPayload(item, variant);
  }

  validate(payload: DepopListingPayload): ValidationIssue[] {
    return validateDepopPayload(payload);
  }

  /** The SKU of the item's next Depop listing (sku.ts). */
  newListingId(item: ItemSnapshot, usedIds: readonly string[]): string {
    return nextDepopSku(item.sku, usedIds);
  }

  // Execute ----------------------------------------------------------------------------------

  async execute(op: OperationRequest<DepopListingPayload>, ctx: AdapterContext): Promise<Outcome> {
    const id = op.listing.externalListingId;
    if (id === null) {
      return op.kind === 'create' || op.kind === 'relist'
        ? {
            type: 'rejected',
            code: 'not_named',
            message: `Listora didn't name this ${NAME} listing, so it can't send it.`,
          }
        : {
            type: 'rejected',
            code: 'not_listed',
            message: `This listing isn't on ${NAME} yet.`,
            fixHint: 'Publish the listing first.',
          };
    }
    const product = depopProductRef(id);

    switch (op.kind) {
      case 'create':
      case 'relist':
      case 'revise': {
        if (op.payload === null) return missingPayload();
        // A new listing (create, relist) is always made under a SKU Listora named.
        if (op.kind !== 'revise' && product.by !== 'sku') {
          return {
            type: 'rejected',
            code: 'not_named',
            message: `Listora didn't name this ${NAME} listing, so it can't send it.`,
          };
        }
        const settings = this.#seller.listingSettings(ctx.connection);
        if (settings === null) {
          return {
            type: 'rejected',
            code: 'settings_missing',
            message: `Listora doesn't know how this seller ships on ${NAME} yet.`,
            fixHint: `Set up ${NAME} shipping, then tap Retry.`,
          };
        }
        return this.#write(op.kind, product, ctx, {
          method: 'PUT',
          path: depopProductPath(product),
          body: productBody(op.payload, settings),
          group: 'listing_write',
        });
      }
      case 'price': {
        const { priceCents } = op.desired;
        if (priceCents === undefined) return missingPayload();
        return this.#write(op.kind, product, ctx, {
          method: 'PATCH',
          path: depopProductPath(product),
          body: { price_amount: depopAmount(priceCents) },
          group: 'other',
        });
      }
      case 'end':
        return this.#write(op.kind, product, ctx, {
          method: 'DELETE',
          path: depopProductPath(product),
          group: 'other',
        });
      case 'mark_sold':
        return this.#write(op.kind, product, ctx, {
          method: 'POST',
          path: depopProductPath(product, 'mark-as-sold/'),
          group: 'other',
        });
      default:
        return assertNever(op.kind, 'operation kind');
    }
  }

  async #write(
    kind: OperationRequest['kind'],
    product: DepopProductRef,
    ctx: AdapterContext,
    call: {
      method: 'PUT' | 'PATCH' | 'DELETE' | 'POST';
      path: string;
      body?: unknown;
      group: DepopRateGroup;
    },
  ): Promise<Outcome> {
    const result = await this.#api.call(call, ctx);
    const excerpt: Excerpt = {
      request: { method: call.method, by: product.by, id: product.value },
      response: responseExcerpt(result),
    };
    const failure = this.#failure(result, excerpt);
    if (failure !== null) return failure;
    if (result.type !== 'response') throw new Error('every other result is a failure');

    if (result.status === 200 || result.status === 204) {
      // A new listing's id is its SKU, which Listora named; Depop answers with it too.
      return {
        type: 'confirmed',
        ...(kind === 'create' || kind === 'relist' ? { externalListingId: product.value } : {}),
        excerpt,
      };
    }
    const [error] = depopErrors(result.body);
    const code = error?.code ?? '';
    const reason = refusalText(error?.message ?? '', result.status);
    if (result.status === 404) {
      return {
        type: 'rejected',
        code: 'not_found',
        message: `This listing isn't on ${NAME}.`,
        excerpt,
      };
    }
    if (code === 'product_not_on_sale' || (code === 'duplicate_sku' && kind === 'revise')) {
      return {
        type: 'rejected',
        code: 'not_active',
        message: `This ${NAME} listing isn't on sale, so it can't be changed.`,
        fixHint: 'Relist it first.',
        excerpt,
      };
    }
    if (code === 'duplicate_sku') {
      return {
        type: 'rejected',
        code: 'sku_used',
        message: `${NAME} already had a listing under this listing's SKU, which it never reuses.`,
        excerpt,
      };
    }
    if (code === 'product_has_been_banned') {
      return {
        type: 'rejected',
        code: 'banned',
        message: `${NAME} has banned this listing, so it can't be changed.`,
        excerpt,
      };
    }
    return {
      type: 'rejected',
      code:
        code === '' ? `http_${String(result.status)}` : `depop_${code.replace(/[^a-z_]/g, '_')}`,
      message: `${NAME} refused the change: ${reason}`,
      fixHint: 'Fix the listing details, then retry.',
      excerpt,
    };
  }

  /** The outcome of a call that failed before Depop could say yes or no, else `null`. */
  #failure(result: DepopCallResult, excerpt: Excerpt): Outcome | null {
    switch (result.type) {
      case 'token_failed':
        return result.error instanceof DepopReauthRequiredError
          ? reauthRequired(excerpt)
          : {
              type: 'transient',
              code: 'token_unavailable',
              message: `Listora couldn't sign in to ${NAME} right now.`,
              excerpt,
            };
      case 'rate_limited':
        return {
          type: 'transient',
          code: 'rate_limited',
          message: `Listora is pacing its requests to ${NAME}; it will try again shortly.`,
          retryAfterMs: result.retryAfterMs,
          excerpt,
        };
      case 'not_sent':
        return {
          type: 'transient',
          code: 'network_error',
          message: `Listora couldn't reach ${NAME}.`,
          excerpt,
        };
      case 'maybe_sent':
        return {
          type: 'unknown',
          code: result.code,
          message:
            result.code === 'timeout'
              ? `${NAME} didn't answer in time.`
              : `The connection to ${NAME} was lost.`,
          excerpt,
        };
      case 'response':
        break;
      default:
        return assertNever(result, 'Depop call result');
    }
    const { status } = result;
    if (status === 429) {
      const wait = retryAfterMs(result.headers);
      return {
        type: 'transient',
        code: 'rate_limited',
        message: `${NAME} is limiting requests right now.`,
        ...(wait === undefined ? {} : { retryAfterMs: wait }),
        excerpt,
      };
    }
    if (status >= 500) {
      return {
        type: 'transient',
        code: 'server_error',
        message: `${NAME} had a temporary problem.`,
        excerpt,
      };
    }
    const [error] = depopErrors(result.body);
    if (status === 401 && error?.code === 'partner_access_denied') {
      return {
        type: 'rejected',
        code: 'partner_access_denied',
        message: `${NAME} has paused Listora's access to its API.`,
        excerpt,
      };
    }
    if (status === 401 || status === 403) return reauthRequired(excerpt);
    return null;
  }

  // Read-back --------------------------------------------------------------------------------

  /**
   * Reads the listing by its id (its SKU, or a linked listing's slug), or by the listing's
   * external SKU before it has an id.
   */
  async readListing(ref: ListingRef, ctx: AdapterContext): Promise<RemoteListingState> {
    const id = ref.externalListingId ?? ref.externalSku;
    if (id === null) return { found: false, authoritative: false };
    const product = depopProductRef(id);
    const result = await this.#api.call(
      { method: 'GET', path: depopProductPath(product), group: 'other' },
      ctx,
    );
    if (result.type !== 'response') throw new Error(`${NAME} could not be read (${result.type})`);
    // Never definitive: a new listing "can take a short time to become retrievable".
    if (result.status === 404) return { found: false, authoritative: false };
    if (result.status !== 200) {
      throw new Error(`${NAME} could not be read (HTTP ${String(result.status)})`);
    }
    const parsed = depopProductSchema.safeParse(result.body);
    if (!parsed.success) throw new Error(`${NAME} answered with an unreadable listing`);
    if (product.by === 'sku' && parsed.data.sku !== product.value) {
      throw new Error(`${NAME} answered with another listing`);
    }
    return depopRemoteListing(id, parsed.data);
  }

  // Health -----------------------------------------------------------------------------------

  /** One `GET /api/v1/shop/` (the seller's details): it checks the token and the API. */
  async healthCheck(ctx: AdapterContext): Promise<Health> {
    const result = await this.#api.call(
      { method: 'GET', path: '/api/v1/shop/', group: 'other' },
      ctx,
    );
    const unreachable: Health = {
      status: 'degraded',
      code: 'unreachable',
      message: `Listora couldn't reach ${NAME}.`,
    };
    switch (result.type) {
      case 'token_failed':
        return result.error instanceof DepopReauthRequiredError ? expired() : unreachable;
      case 'rate_limited':
        return {
          status: 'degraded',
          code: 'rate_limited',
          message: `${NAME} isn't answering normally right now.`,
        };
      case 'not_sent':
      case 'maybe_sent':
        return unreachable;
      case 'response':
        break;
      default:
        return assertNever(result, 'Depop call result');
    }
    if (result.status === 200) return { status: 'ok' };
    if (result.status === 401 || result.status === 403) return expired();
    return {
      status: 'degraded',
      code: result.status === 429 ? 'rate_limited' : `http_${String(result.status)}`,
      message: `${NAME} isn't answering normally right now.`,
    };
  }

  // Orders -----------------------------------------------------------------------------------

  /**
   * One page of the seller's orders, newest first, for the poll that reconciles sales the
   * webhooks may have missed (`from` is an ISO 8601 time). `unavailable` when Depop can't be
   * read now, with whether the seller must reconnect.
   */
  async listOrders(
    query: { cursor?: string; from?: string; limit?: number },
    ctx: AdapterContext,
  ): Promise<
    { type: 'ok'; page: DepopOrdersPage } | { type: 'unavailable'; reauthRequired: boolean }
  > {
    const params = new URLSearchParams({ limit: String(query.limit ?? 50) });
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.from !== undefined) params.set('from', query.from);
    const result = await this.#api.call(
      { method: 'GET', path: `/api/v1/orders/?${params.toString()}`, group: 'other' },
      ctx,
    );
    const reauthRequired =
      (result.type === 'token_failed' && result.error instanceof DepopReauthRequiredError) ||
      (result.type === 'response' && (result.status === 401 || result.status === 403));
    if (result.type !== 'response' || result.status !== 200) {
      return { type: 'unavailable', reauthRequired };
    }
    const page = parseDepopOrdersPage(result.body);
    return page === null ? { type: 'unavailable', reauthRequired: false } : { type: 'ok', page };
  }
}

/**
 * The Selling API's `ProductPutRequest` for a payload and the seller's settings: the listing
 * text with its hashtag line, the price as a decimal, one in stock, the photos in posting
 * order, and the seller's address and shipping. `is_boosted` is never sent: leaving it out
 * keeps a product's boost as it is.
 */
export function productBody(
  payload: DepopListingPayload,
  settings: DepopListingSettings,
): Record<string, unknown> {
  const { shipping } = settings;
  const sizeSetId = payload.sizeSetId === null ? null : depopSizeId(payload.sizeSetId);
  const sizeId = payload.sizeId === null ? null : depopSizeId(payload.sizeId);
  return {
    address: {
      country_code: settings.address.countryCode,
      ...(settings.address.state === null ? {} : { state: settings.address.state }),
    },
    description: depopDescription(payload.description, payload.hashtags),
    price_currency: payload.currency,
    price_amount: depopAmount(payload.priceCents),
    quantity: 1,
    pictures: payload.pictureUrls.map((url) => ({ url })),
    department: payload.department,
    product_type: payload.productType,
    ...(sizeSetId === null || sizeId === null ? {} : { size_set_id: sizeSetId, size_id: sizeId }),
    condition: payload.condition,
    ...(payload.colours.length === 0 ? {} : { colour: payload.colours }),
    brand_name: payload.brand,
    attributes: payload.attributes,
    ...(shipping.type === 'depop'
      ? {
          depop_shipping: {
            address_id: shipping.addressId,
            shipping_provider_id: shipping.providerId,
            parcel_size_id: shipping.parcelSizeId,
            payer: shipping.payer,
          },
        }
      : { national_shipping_cost: depopAmount(shipping.nationalCostCents) }),
  };
}

function refusalText(message: string, status: number): string {
  const text = message.trim() === '' ? `HTTP ${String(status)}` : message.trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function reauthRequired(excerpt: Excerpt): Outcome {
  return {
    type: 'rejected',
    code: 'reauth_required',
    message: `Listora's access to ${NAME} has expired.`,
    fixHint: `Reconnect ${NAME}, then tap Retry.`,
    excerpt,
  };
}

function expired(): Health {
  return {
    status: 'reauth_required',
    code: 'unauthorized',
    message: `Listora's access to ${NAME} has expired.`,
  };
}

function missingPayload(): Outcome {
  return {
    type: 'rejected',
    code: 'missing_content',
    message: `This change has no listing details to send to ${NAME}.`,
  };
}

/** What the operation history keeps of an answer: never the request body or tokens. */
function responseExcerpt(result: DepopCallResult): Excerpt {
  switch (result.type) {
    case 'response': {
      const errors = depopErrors(result.body).map((error) => error.code);
      const errorId = (result.body as { id?: unknown } | null)?.id;
      return {
        status: result.status,
        ...(errors.length === 0 ? {} : { errors }),
        ...(typeof errorId === 'string' && result.status >= 400 ? { errorId } : {}),
      };
    }
    case 'rate_limited':
      return { error: 'paced', retryAfterMs: result.retryAfterMs };
    case 'token_failed':
      return {
        error:
          result.error instanceof DepopReauthRequiredError
            ? 'reauth_required'
            : 'token_unavailable',
      };
    case 'not_sent':
    case 'maybe_sent':
      return { error: result.code };
    default:
      return assertNever(result, 'Depop call result');
  }
}
