/**
 * The eBay REST APIs the adapter uses besides Trading, each with an OAuth bearer token:
 *
 * - Media `createImageFromUrl` copies a listing photo into eBay Picture Services (EPS); the
 *   returned EPS URL goes into the Trading listing's `PictureURL`.
 * - Taxonomy `getCategorySuggestions` and `getItemAspectsForCategory` (application token).
 * - Fulfillment `getOrders` (the seller's sales; the health check's cheap call).
 * - Developer Analytics `getRateLimits` (the application's Trading API usage, budget.ts).
 *
 * Shapes follow eBay's published OpenAPI documents for these APIs (fake/README.md lists them).
 * Every method returns a result instead of throwing for an eBay answer.
 */
import { requestJson, type HttpResult } from '../http.ts';
import type { TradingUsage, TradingUsageSource } from './budget.ts';
import type { ApplicationToken } from './oauth.ts';

/** One entry of a REST error response (`errors[]`). */
export interface RestError {
  errorId: number;
  message: string;
  longMessage: string;
}

export type RestResult<T> =
  | { type: 'ok'; value: T }
  /** eBay answered with an error status. */
  | { type: 'error'; status: number; errors: RestError[]; retryAfterMs?: number }
  | Extract<HttpResult, { type: 'not_sent' | 'maybe_sent' }>;

export interface RestEndpoints {
  /** `https://api.ebay.com` (Taxonomy, Fulfillment, Analytics). */
  api: string;
  /** `https://apim.ebay.com` (Media). */
  media: string;
}

interface RestRequestOptions {
  token: string;
  signal: AbortSignal;
  timeoutMs: number;
}

async function rest<T>(
  method: 'GET' | 'POST',
  url: string,
  options: RestRequestOptions,
  read: (body: unknown, headers: Headers) => T | undefined,
  body?: unknown,
): Promise<RestResult<T>> {
  const result = await requestJson({
    method,
    url,
    headers: { authorization: `Bearer ${options.token}` },
    ...(body === undefined ? {} : { body }),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  if (result.type !== 'response') return result;
  if (result.status >= 200 && result.status < 300) {
    const value = read(result.body, result.headers);
    // A success eBay never sends; treat it like a garbled answer.
    if (value === undefined) return { type: 'maybe_sent', code: 'connection_lost' };
    return { type: 'ok', value };
  }
  const retryAfter = Number(result.headers.get('retry-after'));
  return {
    type: 'error',
    status: result.status,
    errors: restErrors(result.body),
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
  };
}

function restErrors(body: unknown): RestError[] {
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((entry: unknown) => {
    const { errorId, message, longMessage } = (entry ?? {}) as Record<string, unknown>;
    return {
      errorId: typeof errorId === 'number' ? errorId : 0,
      message: typeof message === 'string' ? message : '',
      longMessage: typeof longMessage === 'string' ? longMessage : '',
    };
  });
}

// Media ------------------------------------------------------------------------------------

/** Copies a photo (an https URL eBay can fetch) into EPS and returns its EPS URL. */
export function createImageFromUrl(
  endpoints: RestEndpoints,
  imageUrl: string,
  options: RestRequestOptions,
): Promise<RestResult<string>> {
  return rest(
    'POST',
    `${endpoints.media}/commerce/media/v1_beta/image/create_image_from_url`,
    options,
    (body) => {
      const url = (body as { imageUrl?: unknown } | null)?.imageUrl;
      return typeof url === 'string' && url.startsWith('https://') ? url : undefined;
    },
    { imageUrl },
  );
}

// Taxonomy ---------------------------------------------------------------------------------

/** eBay US's category tree (`getDefaultCategoryTreeId` for EBAY_US). */
export const EBAY_US_CATEGORY_TREE_ID = '0';

export interface CategorySuggestion {
  categoryId: string;
  categoryName: string;
  /** Ancestor names, nearest first (as eBay orders `categoryTreeNodeAncestors`). */
  ancestors: string[];
}

export function getCategorySuggestions(
  endpoints: RestEndpoints,
  query: string,
  options: RestRequestOptions,
): Promise<RestResult<CategorySuggestion[]>> {
  const url = `${endpoints.api}/commerce/taxonomy/v1/category_tree/${EBAY_US_CATEGORY_TREE_ID}/get_category_suggestions?q=${encodeURIComponent(query)}`;
  return rest('GET', url, options, (body) => {
    if (body === null) return [];
    const suggestions = (body as { categorySuggestions?: unknown }).categorySuggestions;
    if (!Array.isArray(suggestions)) return [];
    return suggestions.flatMap((entry: unknown) => {
      const { category, categoryTreeNodeAncestors } = (entry ?? {}) as {
        category?: { categoryId?: unknown; categoryName?: unknown };
        categoryTreeNodeAncestors?: { categoryName?: unknown }[];
      };
      if (typeof category?.categoryId !== 'string' || typeof category.categoryName !== 'string') {
        return [];
      }
      return [
        {
          categoryId: category.categoryId,
          categoryName: category.categoryName,
          ancestors: (categoryTreeNodeAncestors ?? []).flatMap((ancestor) =>
            typeof ancestor.categoryName === 'string' ? [ancestor.categoryName] : [],
          ),
        },
      ];
    });
  });
}

export interface CategoryAspect {
  name: string;
  required: boolean;
  /** `SELECTION_ONLY`: only `values` are accepted. `FREE_TEXT`: any value. */
  mode: 'FREE_TEXT' | 'SELECTION_ONLY';
  /** `SINGLE` or `MULTI`. */
  cardinality: 'SINGLE' | 'MULTI';
  values: string[];
  maxLength: number | null;
}

export function getItemAspectsForCategory(
  endpoints: RestEndpoints,
  categoryId: string,
  options: RestRequestOptions,
): Promise<RestResult<CategoryAspect[]>> {
  const url = `${endpoints.api}/commerce/taxonomy/v1/category_tree/${EBAY_US_CATEGORY_TREE_ID}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`;
  return rest('GET', url, options, (body) => {
    if (body === null) return [];
    const aspects = (body as { aspects?: unknown }).aspects;
    if (!Array.isArray(aspects)) return [];
    return aspects.flatMap((entry: unknown): CategoryAspect[] => {
      const { localizedAspectName, aspectConstraint, aspectValues } = (entry ?? {}) as {
        localizedAspectName?: unknown;
        aspectConstraint?: {
          aspectRequired?: unknown;
          aspectMode?: unknown;
          itemToAspectCardinality?: unknown;
          aspectMaxLength?: unknown;
        };
        aspectValues?: { localizedValue?: unknown }[];
      };
      if (typeof localizedAspectName !== 'string') return [];
      return [
        {
          name: localizedAspectName,
          required: aspectConstraint?.aspectRequired === true,
          mode: aspectConstraint?.aspectMode === 'SELECTION_ONLY' ? 'SELECTION_ONLY' : 'FREE_TEXT',
          cardinality: aspectConstraint?.itemToAspectCardinality === 'MULTI' ? 'MULTI' : 'SINGLE',
          values: (aspectValues ?? []).flatMap((value) =>
            typeof value.localizedValue === 'string' ? [value.localizedValue] : [],
          ),
          maxLength:
            typeof aspectConstraint?.aspectMaxLength === 'number'
              ? aspectConstraint.aspectMaxLength
              : null,
        },
      ];
    });
  });
}

// Fulfillment ------------------------------------------------------------------------------

export interface EbayOrder {
  orderId: string;
  creationDate: string;
  lastModifiedDate: string;
  orderFulfillmentStatus: string;
  orderPaymentStatus: string;
  cancelState: string | null;
  total: { value: string; currency: string } | null;
  lineItems: {
    lineItemId: string;
    legacyItemId: string;
    sku: string | null;
    quantity: number;
    title: string;
  }[];
}

export interface OrdersPage {
  orders: EbayOrder[];
  total: number;
  /** The next page's URL, when there is one. */
  next: string | null;
}

/**
 * One page of the seller's orders, oldest change first is not guaranteed; callers page with
 * `next`. `modifiedSince` filters on `lastmodifieddate` (the backstop poll, T-17).
 */
export function getOrders(
  endpoints: RestEndpoints,
  query: { modifiedSince?: Date; limit?: number; offset?: number; pageUrl?: string },
  options: RestRequestOptions,
): Promise<RestResult<OrdersPage>> {
  const params = new URLSearchParams();
  if (query.modifiedSince !== undefined) {
    params.set('filter', `lastmodifieddate:[${query.modifiedSince.toISOString()}..]`);
  }
  params.set('limit', String(query.limit ?? 50));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  const url = query.pageUrl ?? `${endpoints.api}/sell/fulfillment/v1/order?${params.toString()}`;
  return rest('GET', url, options, (body) => {
    const page = (body ?? {}) as { orders?: unknown; total?: unknown; next?: unknown };
    const orders = Array.isArray(page.orders) ? page.orders.flatMap(readOrder) : [];
    return {
      orders,
      total: typeof page.total === 'number' ? page.total : orders.length,
      next: typeof page.next === 'string' ? page.next : null,
    };
  });
}

function readOrder(entry: unknown): EbayOrder[] {
  const order = (entry ?? {}) as Record<string, unknown>;
  if (typeof order['orderId'] !== 'string') return [];
  const total = (
    order['pricingSummary'] as { total?: { value?: unknown; currency?: unknown } } | undefined
  )?.total;
  const lineItems = Array.isArray(order['lineItems']) ? (order['lineItems'] as unknown[]) : [];
  const string = (value: unknown): string => (typeof value === 'string' ? value : '');
  return [
    {
      orderId: order['orderId'],
      creationDate: string(order['creationDate']),
      lastModifiedDate: string(order['lastModifiedDate']),
      orderFulfillmentStatus: string(order['orderFulfillmentStatus']),
      orderPaymentStatus: string(order['orderPaymentStatus']),
      cancelState:
        typeof (order['cancelStatus'] as { cancelState?: unknown } | undefined)?.cancelState ===
        'string'
          ? (order['cancelStatus'] as { cancelState: string }).cancelState
          : null,
      total:
        typeof total?.value === 'string' && typeof total.currency === 'string'
          ? { value: total.value, currency: total.currency }
          : null,
      lineItems: lineItems.map((line) => {
        const item = (line ?? {}) as Record<string, unknown>;
        return {
          lineItemId: string(item['lineItemId']),
          legacyItemId: string(item['legacyItemId']),
          sku: typeof item['sku'] === 'string' ? item['sku'] : null,
          quantity: typeof item['quantity'] === 'number' ? item['quantity'] : 1,
          title: string(item['title']),
        };
      }),
    },
  ];
}

// Developer Analytics ----------------------------------------------------------------------

/** The time window of eBay's app-wide daily call quota, in seconds. */
const DAY_SECONDS = 86_400;

/**
 * The application's Trading API usage from `getRateLimits` (`api_context=tradingapi`): the
 * app-wide daily quota (the `TradingAPI` resource's 86,400-second window, else the largest
 * daily one). Per-call and short-window rates are not the daily budget and never stand in
 * for it.
 */
export class AnalyticsTradingUsage implements TradingUsageSource {
  readonly #endpoints: RestEndpoints;
  readonly #token: ApplicationToken;
  readonly #timeoutMs: number;
  readonly #now: () => number;

  constructor(
    endpoints: RestEndpoints,
    token: ApplicationToken,
    options: { timeoutMs?: number; now?: () => number } = {},
  ) {
    this.#endpoints = endpoints;
    this.#token = token;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  async read(signal: AbortSignal): Promise<TradingUsage> {
    const token = await this.#token.get(signal);
    const result = await rest(
      'GET',
      `${this.#endpoints.api}/developer/analytics/v1_beta/rate_limit/?api_context=tradingapi`,
      { token, signal, timeoutMs: this.#timeoutMs },
      (body) => tradingUsage(body, this.#now()),
    );
    if (result.type === 'error' && result.status === 401) this.#token.forget(token);
    if (result.type !== 'ok')
      throw new Error(`eBay's call usage could not be read (${result.type})`);
    return result.value;
  }
}

export function tradingUsage(body: unknown, now: number): TradingUsage | undefined {
  const limits = (body as { rateLimits?: unknown } | null)?.rateLimits;
  if (!Array.isArray(limits)) return undefined;
  let daily: { usage: TradingUsage; aggregate: boolean } | undefined;
  for (const limit of limits as { resources?: { name?: unknown; rates?: unknown[] }[] }[]) {
    for (const resource of limit.resources ?? []) {
      const aggregate =
        typeof resource.name === 'string' && resource.name.toLowerCase() === 'tradingapi';
      for (const entry of resource.rates ?? []) {
        const rate = (entry ?? {}) as Record<string, unknown>;
        const { limit: quota, remaining, reset, timeWindow } = rate;
        if (typeof quota !== 'number' || typeof remaining !== 'number') continue;
        if (timeWindow !== DAY_SECONDS) continue;
        const resetAt = typeof reset === 'string' ? Date.parse(reset) : Number.NaN;
        const usage: TradingUsage = {
          limit: quota,
          remaining,
          resetAt: Number.isFinite(resetAt) ? resetAt : now + DAY_SECONDS * 1000,
          windowMs: DAY_SECONDS * 1000,
        };
        if (
          daily === undefined ||
          (aggregate && !daily.aggregate) ||
          (aggregate === daily.aggregate && usage.limit > daily.usage.limit)
        ) {
          daily = { usage, aggregate };
        }
      }
    }
  }
  return daily?.usage;
}
