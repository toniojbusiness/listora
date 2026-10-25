/**
 * The eBay adapter (docs/features/ebay.md): listings through the Trading API
 * (AddFixedPriceItem, ReviseFixedPriceItem, EndFixedPriceItem, RelistFixedPriceItem, GetItem),
 * which keeps them editable in Seller Hub, photos through the Media API, categories and item
 * specifics through the Taxonomy API, and the seller's orders through the Fulfillment API.
 *
 * How it keeps the engine's promises:
 * - **Duplicate protection.** A create or relist carries `Item.UUID`, derived from the
 *   operation's idempotency key, so eBay applies it once however often it is sent; a repeat
 *   answers error 488 with the listing's id, which counts as accepted. Listings are tracked
 *   by SKU (`InventoryTrackingMethod=SKU`), so eBay also refuses a second active listing with
 *   the same SKU, and a create whose answer was lost is found again by SKU.
 * - **Read-back.** `readListing` is GetItem by id (or by SKU before eBay's id is known).
 *   GetItem carries no revision or last-modified time (only a "revised" flag), so the adapter
 *   declares `readFreshness: 'none'`: the engine confirms a change only after two matching
 *   reads a delay apart. Error 17 for a listing id ("the listing has been deleted") is the one
 *   definitive absence; a SKU that finds nothing is never definitive.
 * - **Error mapping.** Every Trading, Media, and OAuth answer maps onto confirmed, rejected,
 *   transient, or unknown (`#outcome`); expired authorization is `reauth_required`.
 * - **Daily-call budgeting.** Every Trading call takes a call from the budget (budget.ts),
 *   which keeps a reserve for ends and read-backs.
 */
import { createHash } from 'node:crypto';

import type { CurrencyCode } from '@listora/shared';
import { assertNever } from '@listora/shared';

import type {
  AdapterContext,
  ConnectionRef,
  Excerpt,
  Health,
  ListingRef,
  MarketplaceAdapter,
  MarketplaceCapabilities,
  OperationRequest,
  Outcome,
  RemoteListingState,
  RemoteListingStatus,
  ValidationIssue,
} from '../adapter.ts';
import type { ItemSnapshot, ListingContent, ListingVariant } from '../content.ts';
import type { CallPriority, TradingCallBudget } from './budget.ts';
import { mapEbayCategory, type EbayCategory } from './categories.ts';
import type { EbayEndpoints } from './config.ts';
import { descriptionText } from './description.ts';
import {
  EbayReauthRequiredError,
  EbayTokenUnavailableError,
  type ApplicationToken,
  type EbayListingSettings,
  type EbaySellerSource,
} from './oauth.ts';
import {
  buildEbayPayload,
  validateEbayPayload,
  type EbayItemSpecific,
  type EbayListingPayload,
} from './payload.ts';
import {
  createImageFromUrl,
  getCategorySuggestions,
  getItemAspectsForCategory,
  getOrders,
  type RestEndpoints,
  type RestResult,
} from './rest.ts';
import { matchAllowedValue } from './sizes.ts';
import {
  itemOf,
  succeeded,
  TradingClient,
  type TradingCallName,
  type TradingError,
  type TradingResult,
} from './trading.ts';
import {
  ALREADY_ENDED_ERRORS,
  duplicateUuidItemId,
  QUOTA_ERRORS,
  REAUTH_ERRORS,
  SKU_NOT_FOUND_ERRORS,
  TRADING_ERRORS,
} from './trading-errors.ts';
import { attribute, child, el, text, texts, type XmlElement, type XmlNode } from './xml.ts';

const NAME = 'eBay';

/**
 * eBay's picture placeholder for VerifyAddFixedPriceItem dry runs: "If you don't have an image
 * file, you can use the following fake eBay Picture Services URL" (AddFixedPriceItem reference).
 */
export const EBAY_VERIFY_PICTURE_URL = 'https://i2.ebayimg.com/abc/M28/dummy.jpg';

export interface EbayAdapterOptions {
  endpoints: EbayEndpoints;
  seller: EbaySellerSource;
  /** For the Taxonomy API (`prepareListing`). */
  applicationToken: ApplicationToken;
  budget: TradingCallBudget;
  /** The application's daily Trading limit, reported in the capabilities. */
  tradingDailyLimit: number;
  /**
   * Whether Taxonomy category suggestions can be trusted. eBay's sandbox answers them "with
   * random or boilerplate text", so there `prepareListing` keeps the mapped category.
   */
  categorySuggestions: boolean;
  /** Per-request timeout; a write that times out after sending is `unknown`. Default 20 s. */
  requestTimeoutMs?: number;
}

/** What `prepareListing` found for a listing before it is published. */
export type EbayPreparation =
  | {
      type: 'prepared';
      /** The variant with its eBay category and item specifics pinned. */
      variant: ListingVariant;
      /** Why eBay would refuse the listing as it is; empty when it can be published. */
      issues: ValidationIssue[];
      /** Whether eBay itself checked the listing (VerifyAddFixedPriceItem). */
      verifiedByEbay: boolean;
    }
  /** eBay could not be asked now (unreachable, rate limited, authorization expired). */
  | { type: 'unavailable'; code: string; message: string };

export class EbayAdapter implements MarketplaceAdapter<EbayListingPayload> {
  readonly id = 'ebay' as const;
  readonly #options: EbayAdapterOptions;
  readonly #trading: TradingClient;
  readonly #rest: RestEndpoints;
  readonly #capabilities: MarketplaceCapabilities;

  constructor(options: EbayAdapterOptions) {
    this.#options = options;
    this.#trading = new TradingClient({
      url: options.endpoints.trading,
      budget: options.budget,
      timeoutMs: this.#timeoutMs(),
    });
    this.#rest = { api: options.endpoints.api, media: options.endpoints.media };
    this.#capabilities = {
      connect: 'oauth',
      create: 'api',
      updatePrice: 'api',
      updateDetails: 'api',
      delist: 'api',
      relist: 'api',
      // eBay marks its own sales sold; a sale elsewhere ends the eBay listing instead.
      markSold: 'not_needed',
      verifyRead: 'api',
      readFreshness: 'none',
      title: 'field',
      importListings: 'api',
      saleDetection: ['webhook', 'poll'],
      imageTransport: 'upload',
      taxonomy: 'api',
      pricingData: 'none',
      externalSkuReusable: true,
      limits: { appPerDay: options.tradingDailyLimit },
    };
  }

  capabilities(): MarketplaceCapabilities {
    return this.#capabilities;
  }

  buildPayload(item: ItemSnapshot, variant: ListingVariant): EbayListingPayload {
    return buildEbayPayload(item, variant);
  }

  validate(payload: EbayListingPayload): ValidationIssue[] {
    return validateEbayPayload(payload);
  }

  // Execute ----------------------------------------------------------------------------------

  async execute(op: OperationRequest<EbayListingPayload>, ctx: AdapterContext): Promise<Outcome> {
    const itemId = op.listing.externalListingId;
    if (op.kind !== 'create' && itemId === null) {
      return {
        type: 'rejected',
        code: 'not_listed',
        message: `This listing isn't on ${NAME} yet.`,
        fixHint: 'Publish the listing first.',
      };
    }
    if (op.kind === 'mark_sold') {
      return {
        type: 'rejected',
        code: 'unsupported',
        message: `${NAME} marks its own sales sold; end the listing instead.`,
      };
    }
    const token = await this.#token(ctx);
    if (token.type !== 'ok') return token.outcome;
    const settings = this.#options.seller.listingSettings(ctx.connection);
    const sku = sellerSku(op.listing);

    switch (op.kind) {
      case 'create': {
        if (op.payload === null) return missingPayload();
        const pictures = await this.#uploadPhotos(op.payload.photoUrls, token.token, ctx);
        if (pictures.type !== 'ok') return pictures.outcome;
        const fields = [
          el('Item', [
            ...listingFields(op.payload, pictures.urls),
            ...sellerFields(settings),
            el('SKU', sku),
            el('InventoryTrackingMethod', 'SKU'),
            el('UUID', ebayUuid(op.idempotencyKey)),
          ]),
        ];
        return this.#write('AddFixedPriceItem', fields, pictures.token, ctx, 'normal');
      }
      case 'revise': {
        if (op.payload === null) return missingPayload();
        const pictures = await this.#uploadPhotos(op.payload.photoUrls, token.token, ctx);
        if (pictures.type !== 'ok') return pictures.outcome;
        const fields = [
          el('Item', [
            el('ItemID', itemId ?? ''),
            el('InventoryTrackingMethod', 'SKU'),
            el('SKU', sku),
            ...listingFields(op.payload, pictures.urls, 'revise'),
          ]),
          ...deletedFields(op.payload),
        ];
        return this.#write('ReviseFixedPriceItem', fields, pictures.token, ctx, 'normal');
      }
      case 'price': {
        const { priceCents } = op.desired;
        if (priceCents === undefined) return missingPayload();
        const fields = [
          el('Item', [
            el('ItemID', itemId ?? ''),
            el('InventoryTrackingMethod', 'SKU'),
            el('SKU', sku),
            el('StartPrice', priceText(priceCents), { currencyID: op.desired.currency ?? 'USD' }),
          ]),
        ];
        return this.#write('ReviseFixedPriceItem', fields, token.token, ctx, 'normal');
      }
      case 'end':
        return this.#write(
          'EndFixedPriceItem',
          [el('ItemID', itemId ?? ''), el('EndingReason', 'NotAvailable')],
          token.token,
          ctx,
          'urgent',
        );
      case 'relist': {
        // A relist publishes the listing's current content, under a new eBay id.
        const item: XmlElement[] = [
          el('ItemID', itemId ?? ''),
          el('UUID', ebayUuid(op.idempotencyKey)),
        ];
        let current = token.token;
        if (op.payload !== null) {
          const pictures = await this.#uploadPhotos(op.payload.photoUrls, current, ctx);
          if (pictures.type !== 'ok') return pictures.outcome;
          current = pictures.token;
          item.push(...listingFields(op.payload, pictures.urls), ...sellerFields(settings));
          item.push(el('SKU', sku), el('InventoryTrackingMethod', 'SKU'));
        }
        return this.#write('RelistFixedPriceItem', [el('Item', item)], current, ctx, 'normal');
      }
      default:
        return assertNever(op.kind, 'operation kind');
    }
  }

  async #write(
    callName: TradingCallName,
    fields: XmlElement[],
    token: string,
    ctx: AdapterContext,
    priority: CallPriority,
  ): Promise<Outcome> {
    const result = await this.#trading.call(callName, fields, {
      token,
      priority,
      signal: ctx.signal,
    });
    return this.#outcome(callName, result, token, ctx.connection);
  }

  /** Maps a Trading answer onto an outcome (docs/features/ebay.md). */
  #outcome(
    callName: TradingCallName,
    result: TradingResult,
    token: string,
    connection: ConnectionRef | null,
  ): Outcome {
    const excerpt: Excerpt = { request: { call: callName }, response: responseExcerpt(result) };
    switch (result.type) {
      case 'over_budget':
        return {
          type: 'transient',
          code: 'call_budget',
          message: `Listora has used today's ${NAME} calls for this kind of change; it will try again when they reset.`,
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
      case 'http_error':
        if (result.status === 429) {
          return {
            type: 'transient',
            code: 'rate_limited',
            message: `${NAME} is limiting requests right now.`,
            ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
            excerpt,
          };
        }
        return {
          type: 'transient',
          code: result.status >= 500 ? 'server_error' : `http_${String(result.status)}`,
          message: `${NAME} had a temporary problem.`,
          excerpt,
        };
      case 'response':
        break;
      default:
        return assertNever(result, 'Trading result');
    }

    if (succeeded(result)) {
      const itemId = text(result.body, 'ItemID');
      return {
        type: 'confirmed',
        ...(itemId !== undefined && itemId !== '0' && callName !== 'ReviseFixedPriceItem'
          ? { externalListingId: itemId }
          : {}),
        excerpt,
      };
    }
    const error = result.errors[0] ?? unknownFailure(result.ack);
    if (REAUTH_ERRORS.has(error.code)) {
      this.#options.seller.forget(connection, token);
      return reauthRequired(excerpt);
    }
    if (error.code === TRADING_ERRORS.iafTokenExpired) {
      // Access tokens last two hours; the next attempt gets a fresh one.
      this.#options.seller.forget(connection, token);
      return {
        type: 'transient',
        code: 'token_expired',
        message: `${NAME} asked Listora to sign in again; it will retry.`,
        retryAfterMs: 1_000,
        excerpt,
      };
    }
    if (QUOTA_ERRORS.has(error.code)) {
      return {
        type: 'transient',
        code: 'call_limit',
        message: `Listora has reached ${NAME}'s daily call limit; it will try again when it resets.`,
        retryAfterMs: this.#options.budget.exhausted(),
        excerpt,
      };
    }
    if (error.code === TRADING_ERRORS.addCallLimit) {
      return {
        type: 'transient',
        code: 'rate_limited',
        message: `${NAME} is limiting new listings right now.`,
        excerpt,
      };
    }
    if (error.code === TRADING_ERRORS.duplicateUuid) {
      // eBay already applied this create or relist (the same UUID); it names the listing.
      const existing = duplicateUuidItemId(error.longMessage, error.parameters);
      return existing === null
        ? {
            type: 'unknown',
            code: 'duplicate',
            message: `${NAME} says this was already done.`,
            excerpt,
          }
        : { type: 'confirmed', externalListingId: existing, excerpt };
    }
    if (callName === 'AddFixedPriceItem' && error.code === TRADING_ERRORS.duplicateActiveSku) {
      // A live listing already has this SKU: the read-back by SKU decides whether it is this one.
      return { type: 'confirmed', excerpt };
    }
    if (callName === 'EndFixedPriceItem' && ALREADY_ENDED_ERRORS.has(error.code)) {
      return { type: 'confirmed', excerpt };
    }
    if (error.code === TRADING_ERRORS.itemNotAccessible) {
      return {
        type: 'rejected',
        code: 'not_found',
        message: `This listing no longer exists on ${NAME}.`,
        excerpt,
      };
    }
    if (error.code === TRADING_ERRORS.revisedEnded) {
      return {
        type: 'rejected',
        code: 'not_active',
        message: `This ${NAME} listing has ended, so it can't be changed.`,
        fixHint: 'Relist it first.',
        excerpt,
      };
    }
    if (error.code === TRADING_ERRORS.cannotRelist) {
      return {
        type: 'rejected',
        code: 'cannot_relist',
        message: `${NAME} can't relist this listing: it is still active, or it ended too long ago.`,
        excerpt,
      };
    }
    if (error.classification === 'SystemError' || error.code === TRADING_ERRORS.systemError) {
      return {
        type: 'transient',
        code: 'server_error',
        message: `${NAME} had a temporary problem.`,
        excerpt,
      };
    }
    return {
      type: 'rejected',
      code: `ebay_${error.code || 'error'}`,
      message: `${NAME} refused the change: ${refusalText(error)}`,
      fixHint: 'Fix the listing details, then retry.',
      excerpt,
    };
  }

  // Photos -----------------------------------------------------------------------------------

  /**
   * Copies the listing's photos into eBay Picture Services, in posting order. Nothing is
   * listed until every photo is in, so any failure here leaves eBay unchanged (an unused EPS
   * image expires by itself after 30 days). Returns the token it ended with: a stale one is
   * refreshed on the way (`#withSellerToken`).
   */
  async #uploadPhotos(
    urls: readonly string[],
    token: string,
    ctx: AdapterContext,
  ): Promise<{ type: 'ok'; urls: string[]; token: string } | { type: 'failed'; outcome: Outcome }> {
    const uploaded: string[] = [];
    let current = token;
    // A few at a time: Media POSTs are limited to 50 per 5 seconds per seller.
    for (let start = 0; start < urls.length; start += 4) {
      const batch = urls.slice(start, start + 4);
      const results = await Promise.all(
        batch.map((url) =>
          this.#withSellerToken(ctx, current, (fresh) =>
            createImageFromUrl(this.#rest, url, {
              token: fresh,
              signal: ctx.signal,
              timeoutMs: this.#timeoutMs(),
            }),
          ),
        ),
      );
      for (const [index, result] of results.entries()) {
        if (result.type === 'token_failed') return { type: 'failed', outcome: result.outcome };
        current = result.token;
        if (result.result.type === 'ok') {
          uploaded.push(result.result.value);
          continue;
        }
        const position = start + index + 1;
        return {
          type: 'failed',
          outcome: this.#photoFailure(result.result, position, result.token, ctx.connection),
        };
      }
    }
    return { type: 'ok', urls: uploaded, token: current };
  }

  /**
   * Runs a REST call with the seller's token. A 401 ("Invalid access token") means the token
   * is stale (eBay: refresh "after it expires (and you receive an 'Invalid access token'
   * error)"), so the call runs once more with a fresh one; reads and photo uploads change no
   * listing, so that is always safe.
   */
  async #withSellerToken<T>(
    ctx: AdapterContext,
    token: string,
    call: (token: string) => Promise<RestResult<T>>,
  ): Promise<
    | { type: 'result'; result: RestResult<T>; token: string }
    | { type: 'token_failed'; code: string; outcome: Outcome }
  > {
    const result = await call(token);
    if (result.type !== 'error' || result.status !== 401) return { type: 'result', result, token };
    this.#options.seller.forget(ctx.connection, token);
    const fresh = await this.#token(ctx);
    if (fresh.type !== 'ok')
      return { type: 'token_failed', code: fresh.code, outcome: fresh.outcome };
    return { type: 'result', result: await call(fresh.token), token: fresh.token };
  }

  #photoFailure(
    result: Exclude<RestResult<string>, { type: 'ok' }>,
    position: number,
    token: string,
    connection: ConnectionRef | null,
  ): Outcome {
    const excerpt: Excerpt = {
      request: { call: 'createImageFromUrl', photo: position },
      response:
        result.type === 'error'
          ? { status: result.status, errorIds: result.errors.map((error) => error.errorId) }
          : { error: result.code },
    };
    if (result.type !== 'error') {
      return {
        type: 'transient',
        code: 'photo_upload_failed',
        message: `Listora couldn't send photo ${String(position)} to ${NAME}.`,
        excerpt,
      };
    }
    if (result.status === 401 || result.status === 403) {
      this.#options.seller.forget(connection, token);
      return reauthRequired(excerpt);
    }
    if (result.status === 429) {
      return {
        type: 'transient',
        code: 'rate_limited',
        message: `${NAME} is limiting photo uploads right now.`,
        ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
        excerpt,
      };
    }
    if (result.status >= 500) {
      return {
        type: 'transient',
        code: 'server_error',
        message: `${NAME} had a temporary problem with photo ${String(position)}.`,
        excerpt,
      };
    }
    const reason = result.errors[0]?.message ?? `HTTP ${String(result.status)}`;
    return {
      type: 'rejected',
      code: 'photo_rejected',
      message: `${NAME} couldn't use photo ${String(position)}: ${reason}`,
      fixHint: 'Replace the photo, then retry.',
      excerpt,
    };
  }

  // Read-back --------------------------------------------------------------------------------

  async readListing(ref: ListingRef, ctx: AdapterContext): Promise<RemoteListingState> {
    const itemId = ref.externalListingId;
    // eBay listing ids are numbers; anything else can't be a listing eBay knows.
    if (itemId !== null && !/^\d{1,19}$/.test(itemId))
      return { found: false, authoritative: false };
    const token = await this.#token(ctx);
    if (token.type !== 'ok') throw new Error(`${NAME} could not be read (${token.code})`);
    const result = await this.#trading.call(
      'GetItem',
      [
        itemId === null ? el('SKU', sellerSku(ref)) : el('ItemID', itemId),
        el('DetailLevel', 'ItemReturnDescription'),
      ],
      { token: token.token, priority: 'urgent', signal: ctx.signal },
    );
    if (result.type !== 'response') {
      throw new Error(
        `${NAME} could not be read (${result.type === 'http_error' ? `HTTP ${String(result.status)}` : result.type})`,
      );
    }
    if (!succeeded(result)) {
      const error = result.errors[0] ?? unknownFailure(result.ack);
      // "The listing has been deleted": definitive for an id; a SKU lookup proves nothing.
      if (itemId !== null && error.code === TRADING_ERRORS.itemNotAccessible) {
        return { found: false, authoritative: true };
      }
      if (itemId === null && SKU_NOT_FOUND_ERRORS.has(error.code)) {
        return { found: false, authoritative: false };
      }
      if (REAUTH_ERRORS.has(error.code) || error.code === TRADING_ERRORS.iafTokenExpired) {
        this.#options.seller.forget(ctx.connection, token.token);
      }
      if (QUOTA_ERRORS.has(error.code)) this.#options.budget.exhausted();
      throw new Error(`${NAME} could not be read (error ${error.code})`);
    }
    const item = itemOf(result.body);
    if (item === undefined) throw new Error(`${NAME} answered without the listing`);
    return remoteListing(item);
  }

  // Health -----------------------------------------------------------------------------------

  async healthCheck(ctx: AdapterContext): Promise<Health> {
    const expired: Health = {
      status: 'reauth_required',
      code: 'unauthorized',
      message: `Listora's access to ${NAME} has expired.`,
    };
    const token = await this.#token(ctx);
    if (token.type !== 'ok') {
      return token.code === 'reauth_required'
        ? expired
        : { status: 'degraded', code: 'unreachable', message: `Listora couldn't reach ${NAME}.` };
    }
    // One order from the Fulfillment API: it checks the seller's token without using Trading calls.
    const answer = await this.#withSellerToken(ctx, token.token, (fresh) =>
      getOrders(
        this.#rest,
        { limit: 1 },
        { token: fresh, signal: ctx.signal, timeoutMs: this.#timeoutMs() },
      ),
    );
    if (answer.type === 'token_failed') {
      return answer.code === 'reauth_required'
        ? expired
        : { status: 'degraded', code: 'unreachable', message: `Listora couldn't reach ${NAME}.` };
    }
    const { result } = answer;
    if (result.type === 'ok') return { status: 'ok' };
    if (result.type !== 'error') {
      return {
        status: 'degraded',
        code: 'unreachable',
        message: `Listora couldn't reach ${NAME}.`,
      };
    }
    if (result.status === 401 || result.status === 403) {
      this.#options.seller.forget(ctx.connection, answer.token);
      return expired;
    }
    return {
      status: 'degraded',
      code: result.status === 429 ? 'rate_limited' : `http_${String(result.status)}`,
      message: `${NAME} isn't answering normally right now.`,
    };
  }

  // Prepare ----------------------------------------------------------------------------------

  /**
   * Readies a listing for eBay before it is published (the API calls it when the seller lists
   * an item on eBay): picks the category from Taxonomy suggestions within the mapped
   * category's branch (categories.ts), matches the item specifics to the values eBay allows
   * for that category (the standard sizes among them), and has eBay check the result with
   * VerifyAddFixedPriceItem, which lists nothing. The returned variant is what to publish.
   */
  async prepareListing(content: ListingContent, ctx: AdapterContext): Promise<EbayPreparation> {
    const { item } = content;
    let variant = content.variant;

    if (variant.categoryRef === null) {
      const categoryId = await this.#chooseCategory(item, variant, ctx);
      if (categoryId.type === 'unavailable') return categoryId;
      if (categoryId.value !== null) variant = { ...variant, categoryRef: categoryId.value };
    }

    const issues: ValidationIssue[] = [];
    const categoryRef = variant.categoryRef;
    if (categoryRef !== null) {
      const aspects = await this.#taxonomy(ctx, (rest) =>
        getItemAspectsForCategory(this.#rest, categoryRef, rest),
      );
      if (aspects.type === 'unavailable') return aspects;
      if (aspects.type === 'ok') {
        const derived = buildEbayPayload(item, variant).itemSpecifics;
        const fitted = fitItemSpecifics(derived, aspects.value);
        issues.push(...fitted.issues);
        variant = { ...variant, aspects: fitted.specifics };
      } else if (aspects.type === 'error' && aspects.status === 400) {
        issues.push({
          field: 'variant.categoryRef',
          code: 'invalid',
          message: `${NAME} doesn't list items in category ${categoryRef}.`,
        });
      } else {
        return unavailable(aspects);
      }
    }

    const payload = buildEbayPayload(item, variant);
    issues.push(
      ...validateEbayPayload(payload).filter(
        (issue) =>
          !issues.some((known) => known.field === issue.field && known.code === issue.code),
      ),
    );
    if (issues.length > 0) return { type: 'prepared', variant, issues, verifiedByEbay: false };

    const token = await this.#token(ctx);
    if (token.type !== 'ok') {
      return {
        type: 'unavailable',
        code: token.code,
        message: `Listora couldn't check the listing with ${NAME}.`,
      };
    }
    const settings = this.#options.seller.listingSettings(ctx.connection);
    const verify = await this.#trading.call(
      'VerifyAddFixedPriceItem',
      [
        el('Item', [
          ...listingFields(payload, [EBAY_VERIFY_PICTURE_URL]),
          ...sellerFields(settings),
        ]),
      ],
      { token: token.token, priority: 'normal', signal: ctx.signal },
    );
    if (verify.type !== 'response') {
      return { type: 'prepared', variant, issues: [], verifiedByEbay: false };
    }
    if (succeeded(verify)) return { type: 'prepared', variant, issues: [], verifiedByEbay: true };
    if (verify.errors.some((error) => REAUTH_ERRORS.has(error.code))) {
      this.#options.seller.forget(ctx.connection, token.token);
      return {
        type: 'unavailable',
        code: 'reauth_required',
        message: `Listora's access to ${NAME} has expired.`,
      };
    }
    if (
      verify.errors.some(
        (error) => error.classification === 'SystemError' || QUOTA_ERRORS.has(error.code),
      )
    ) {
      return { type: 'prepared', variant, issues: [], verifiedByEbay: false };
    }
    return {
      type: 'prepared',
      variant,
      issues: verify.errors.map((error) => ({
        field: verifyField(error.code),
        code: `ebay_${error.code}`,
        message: `${NAME}: ${refusalText(error)}`,
      })),
      verifiedByEbay: true,
    };
  }

  async #chooseCategory(
    item: ItemSnapshot,
    variant: ListingVariant,
    ctx: AdapterContext,
  ): Promise<
    { type: 'chosen'; value: string | null } | Extract<EbayPreparation, { type: 'unavailable' }>
  > {
    const mapped = mapEbayCategory(item.category, item.department);
    if (!this.#options.categorySuggestions) {
      return { type: 'chosen', value: mapped?.categoryId ?? null };
    }
    const suggestions = await this.#taxonomy(ctx, (rest) =>
      getCategorySuggestions(this.#rest, variant.title, rest),
    );
    if (suggestions.type !== 'ok') {
      // Without suggestions the map still gives a sound category.
      if (mapped !== null) return { type: 'chosen', value: mapped.categoryId };
      return suggestions.type === 'unavailable' ? suggestions : unavailable(suggestions);
    }
    return {
      type: 'chosen',
      value: chooseEbayCategory(suggestions.value, mapped, item.department),
    };
  }

  // Tokens -----------------------------------------------------------------------------------

  async #token(
    ctx: AdapterContext,
  ): Promise<{ type: 'ok'; token: string } | { type: 'failed'; code: string; outcome: Outcome }> {
    try {
      return {
        type: 'ok',
        token: await this.#options.seller.accessToken(ctx.connection, ctx.signal),
      };
    } catch (error) {
      if (error instanceof EbayReauthRequiredError) {
        return {
          type: 'failed',
          code: 'reauth_required',
          outcome: reauthRequired({ request: { call: 'token' } }, error.message),
        };
      }
      if (error instanceof EbayTokenUnavailableError) {
        return {
          type: 'failed',
          code: 'token_unavailable',
          outcome: {
            type: 'transient',
            code: 'token_unavailable',
            message: `Listora couldn't sign in to ${NAME} right now.`,
            excerpt: { request: { call: 'token' }, response: { error: error.code } },
          },
        };
      }
      throw error;
    }
  }

  /**
   * Runs a Taxonomy call with the application token, once more with a fresh token when eBay
   * says it is invalid (it expires every two hours).
   */
  async #taxonomy<T>(
    ctx: AdapterContext,
    call: (rest: {
      token: string;
      signal: AbortSignal;
      timeoutMs: number;
    }) => Promise<RestResult<T>>,
  ): Promise<RestResult<T> | Extract<EbayPreparation, { type: 'unavailable' }>> {
    const tokenFailure: Extract<EbayPreparation, { type: 'unavailable' }> = {
      type: 'unavailable',
      code: 'token_unavailable',
      message: `Listora couldn't sign in to ${NAME} right now.`,
    };
    const attempt = async (): Promise<{ token: string; result: RestResult<T> } | undefined> => {
      let token: string;
      try {
        token = await this.#options.applicationToken.get(ctx.signal);
      } catch (error) {
        if (
          error instanceof EbayReauthRequiredError ||
          error instanceof EbayTokenUnavailableError
        ) {
          return undefined;
        }
        throw error;
      }
      return {
        token,
        result: await call({ token, signal: ctx.signal, timeoutMs: this.#timeoutMs() }),
      };
    };
    const first = await attempt();
    if (first === undefined) return tokenFailure;
    if (first.result.type !== 'error' || first.result.status !== 401) return first.result;
    this.#options.applicationToken.forget(first.token);
    const second = await attempt();
    return second === undefined ? tokenFailure : second.result;
  }

  #timeoutMs(): number {
    return this.#options.requestTimeoutMs ?? 20_000;
  }
}

// Request fields ------------------------------------------------------------------------------

/**
 * The Trading `Item` fields a payload sets, with the photos' EPS URLs. A revise leaves out the
 * fields only a new listing takes ("ListingType ... is not applicable to Revise calls").
 */
function listingFields(
  payload: EbayListingPayload,
  pictureUrls: readonly string[],
  mode: 'list' | 'revise' = 'list',
): XmlElement[] {
  const listOnly = (field: XmlElement): XmlElement | null => (mode === 'list' ? field : null);
  return [
    el('Title', payload.title),
    el('Description', payload.descriptionHtml),
    payload.categoryId === null
      ? null
      : el('PrimaryCategory', [el('CategoryID', payload.categoryId)]),
    el('StartPrice', priceText(payload.priceCents), { currencyID: payload.currency }),
    listOnly(el('Currency', payload.currency)),
    listOnly(el('Country', 'US')),
    listOnly(el('ListingType', 'FixedPriceItem')),
    listOnly(el('ListingDuration', 'GTC')),
    listOnly(el('Quantity', 1)),
    payload.conditionId === null ? null : el('ConditionID', payload.conditionId),
    payload.conditionDescription === null
      ? null
      : el('ConditionDescription', payload.conditionDescription),
    el(
      'PictureDetails',
      pictureUrls.map((url) => el('PictureURL', url)),
    ),
    el(
      'ItemSpecifics',
      payload.itemSpecifics.map((specific) =>
        el('NameValueList', [
          el('Name', specific.name),
          ...specific.values.map((value) => el('Value', value)),
        ]),
      ),
    ),
  ].filter((field): field is XmlElement => field !== null);
}

/**
 * The fields a revise removes: ReviseFixedPriceItem keeps every field it is not sent, so a
 * value the payload no longer has must be named in a `DeletedField`.
 */
function deletedFields(payload: EbayListingPayload): XmlElement[] {
  return payload.conditionDescription === null
    ? [el('DeletedField', 'Item.ConditionDescription')]
    : [];
}

/**
 * How the seller ships, gets paid, and takes returns: business policies when the seller has
 * them, else free USPS Priority shipping and no returns (development and the sandbox check).
 */
function sellerFields(settings: EbayListingSettings): XmlElement[] {
  const location = el('PostalCode', settings.postalCode);
  if (settings.policies !== null) {
    return [
      location,
      el('SellerProfiles', [
        el('SellerShippingProfile', [
          el('ShippingProfileID', settings.policies.fulfillmentPolicyId),
        ]),
        el('SellerReturnProfile', [el('ReturnProfileID', settings.policies.returnPolicyId)]),
        el('SellerPaymentProfile', [el('PaymentProfileID', settings.policies.paymentPolicyId)]),
      ]),
    ];
  }
  return [
    location,
    el('DispatchTimeMax', settings.dispatchTimeMax),
    el('ShippingDetails', [
      el('ShippingType', 'Flat'),
      el('ShippingServiceOptions', [
        el('ShippingServicePriority', 1),
        el('ShippingService', 'USPSPriority'),
        el('ShippingServiceCost', '0.0', { currencyID: 'USD' }),
        el('FreeShipping', 'true'),
      ]),
    ]),
    el('ReturnPolicy', [el('ReturnsAcceptedOption', 'ReturnsNotAccepted')]),
  ];
}

/** `4500` → `45.00`. */
function priceText(cents: number): string {
  return `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
}

/** eBay amounts are decimals (`45.0`, `39.99`); `null` when one isn't. */
export function priceCents(value: string | undefined): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value?.trim() ?? '');
  if (match?.[1] === undefined) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * eBay's UUID for an operation: 32 uppercase hex digits ("can only contain digits from 0-9
 * and letters from A-F and must be 32 characters long"), the same for every attempt.
 */
export function ebayUuid(idempotencyKey: string): string {
  return createHash('sha256')
    .update(`listora:ebay:${idempotencyKey}`)
    .digest('hex')
    .slice(0, 32)
    .toUpperCase();
}

/** The seller SKU an eBay listing is tracked by: the listing's external SKU, else its id. */
function sellerSku(ref: ListingRef): string {
  return ref.externalSku ?? ref.listingId;
}

function remoteListing(item: XmlNode): Extract<RemoteListingState, { found: true }> {
  const status = child(item, 'SellingStatus');
  const price = child(status, 'CurrentPrice');
  const currency = attribute(price, 'currencyID');
  const itemId = text(item, 'ItemID');
  if (itemId === undefined) throw new Error(`${NAME} answered without a listing id`);
  const description = text(item, 'Description');
  return {
    found: true,
    externalListingId: itemId,
    externalUrl: text(child(item, 'ListingDetails'), 'ViewItemURL') ?? null,
    status: listingStatus(
      text(status, 'ListingStatus'),
      Number(text(status, 'QuantitySold') ?? '0'),
      Number(text(item, 'Quantity') ?? '1'),
    ),
    title: text(item, 'Title') ?? null,
    description: description === undefined ? null : descriptionText(description),
    priceCents: priceCents(text(price, '#text')),
    currency: currency === 'USD' ? (currency satisfies CurrencyCode) : null,
    revision: null,
  };
}

/**
 * eBay's listing status in Listora's terms. "Active" also covers a listing that just sold
 * while eBay finishes the sale, so a listing whose quantity is sold out counts as sold.
 */
function listingStatus(
  value: string | undefined,
  sold: number,
  quantity: number,
): RemoteListingStatus {
  switch (value ?? '') {
    case 'Active':
      return sold > 0 && sold >= quantity ? 'sold' : 'active';
    case 'Completed':
    case 'Ended':
      return sold > 0 ? 'sold' : 'ended';
    default:
      throw new Error(`${NAME} reported an unknown listing status`);
  }
}

/**
 * The category for an item from eBay's suggestions (best first), with the canonical map as
 * input: the best suggestion inside the mapped category's branch, else the mapped category;
 * without a mapping, the best suggestion in the department's part of the tree.
 */
export function chooseEbayCategory(
  suggestions: readonly { categoryId: string; ancestors: string[] }[],
  mapped: EbayCategory | null,
  department: string | null,
): string | null {
  if (mapped !== null) {
    const inBranch = suggestions.find((suggestion) => suggestion.ancestors.includes(mapped.branch));
    return inBranch?.categoryId ?? mapped.categoryId;
  }
  const top = department === 'men' ? 'Men' : department === 'women' ? 'Women' : null;
  const fitting = suggestions.find(
    (suggestion) => top === null || suggestion.ancestors.includes(top),
  );
  return fitting?.categoryId ?? null;
}

/**
 * Fits item specifics to a category's aspects: values matched to the allowed ones (eBay's
 * spelling), one value where only one is allowed, and an issue for a required aspect that is
 * missing or a value eBay would refuse.
 */
export function fitItemSpecifics(
  specifics: readonly EbayItemSpecific[],
  aspects: readonly {
    name: string;
    required: boolean;
    mode: 'FREE_TEXT' | 'SELECTION_ONLY';
    cardinality: 'SINGLE' | 'MULTI';
    values: string[];
  }[],
): { specifics: { name: string; values: string[] }[]; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const reported = new Set<string>();
  const fitted = specifics.map((specific) => {
    const aspect = aspects.find(
      (candidate) => candidate.name.toLowerCase() === specific.name.toLowerCase(),
    );
    if (aspect === undefined) return { name: specific.name, values: [...specific.values] };
    let values = [...specific.values];
    if (aspect.mode === 'SELECTION_ONLY') {
      values = values.flatMap((value) => {
        const allowed = matchAllowedValue(value, aspect.values);
        if (allowed !== null) return [allowed];
        reported.add(aspect.name.toLowerCase());
        issues.push({
          field: aspectField(aspect.name),
          code: 'not_standard',
          message: `${NAME} doesn't accept "${value}" for ${aspect.name}.`,
        });
        return [];
      });
    }
    if (aspect.cardinality === 'SINGLE') values = values.slice(0, 1);
    return { name: aspect.name, values };
  });
  for (const aspect of aspects) {
    if (!aspect.required || reported.has(aspect.name.toLowerCase())) continue;
    const given = fitted.find(
      (specific) => specific.name.toLowerCase() === aspect.name.toLowerCase(),
    );
    if (given === undefined || given.values.length === 0) {
      issues.push({
        field: aspectField(aspect.name),
        code: 'required',
        message: `${NAME} needs ${aspect.name} for this category.`,
      });
    }
  }
  return { specifics: fitted.filter((specific) => specific.values.length > 0), issues };
}

/** The listing field an eBay aspect comes from: the item's size, else the variant's aspects. */
function aspectField(aspect: string): string {
  return aspect === 'Size' || aspect === 'US Shoe Size' ? 'item.sizeLabel' : 'variant.aspects';
}

function verifyField(code: string): string {
  switch (code) {
    case '69':
    case TRADING_ERRORS.titleTooLong:
      return 'variant.title';
    case TRADING_ERRORS.invalidCategory:
      return 'variant.categoryRef';
    case TRADING_ERRORS.conditionRequired:
    case '21916883':
      return 'item.condition';
    case TRADING_ERRORS.photoRequired:
      return 'item.photos';
    default:
      return 'variant.aspects';
  }
}

function refusalText(error: TradingError): string {
  const message = (error.longMessage || error.shortMessage || `error ${error.code}`).trim();
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

function reauthRequired(
  excerpt: Excerpt,
  message = `Listora's access to ${NAME} has expired.`,
): Outcome {
  return {
    type: 'rejected',
    code: 'reauth_required',
    message,
    fixHint: `Reconnect ${NAME}, then tap Retry.`,
    excerpt,
  };
}

function missingPayload(): Outcome {
  return {
    type: 'rejected',
    code: 'missing_content',
    message: `This change has no listing details to send to ${NAME}.`,
  };
}

function unknownFailure(ack: string): TradingError {
  return {
    code: '',
    shortMessage: `${NAME} answered ${ack || 'without a result'}.`,
    longMessage: '',
    severity: 'Error',
    classification: 'SystemError',
    parameters: [],
  };
}

function unavailable(
  result: Exclude<RestResult<unknown>, { type: 'ok' }>,
): Extract<EbayPreparation, { type: 'unavailable' }> {
  if (result.type === 'error' && (result.status === 401 || result.status === 403)) {
    return {
      type: 'unavailable',
      code: 'reauth_required',
      message: `Listora's access to ${NAME} has expired.`,
    };
  }
  return {
    type: 'unavailable',
    code: result.type === 'error' ? `http_${String(result.status)}` : result.code,
    message: `Listora couldn't reach ${NAME} to check the listing.`,
  };
}

/** What the operation history keeps of a Trading answer: never the request body or tokens. */
function responseExcerpt(result: TradingResult): Excerpt {
  switch (result.type) {
    case 'response':
      return {
        ack: result.ack,
        ...(result.errors.length === 0 ? {} : { errors: result.errors.map((error) => error.code) }),
        ...(result.warnings.length === 0
          ? {}
          : { warnings: result.warnings.map((warning) => warning.code) }),
        ...(texts(result.body, 'ItemID').length === 0
          ? {}
          : { itemId: texts(result.body, 'ItemID')[0] ?? '' }),
      };
    case 'http_error':
      return { status: result.status };
    case 'over_budget':
      return { error: 'over_budget' };
    case 'not_sent':
    case 'maybe_sent':
      return { error: result.code };
  }
}
