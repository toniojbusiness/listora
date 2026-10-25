/**
 * `fake-depop`: an HTTP server that speaks the part of Depop's Selling API Listora uses, for
 * development and tests (docs/architecture.md section 5). Every request it accepts and every
 * response it sends is checked against Depop's published openapi.yaml (spec.ts), and it follows
 * Depop's documented rules (README.md cites each), so the Depop adapter can be tested against
 * every failure mode without a credential:
 *
 *   GET  /settings/oauth/apps/                          Consent (Depop's website): redirects
 *                                                       with a code, or `access_denied`
 *   POST /api/v1/oauth2/access-token/                   OAuth: authorization code with PKCE
 *                                                       (S256), and rotating refresh tokens
 *   PUT  /api/v1/products/by-sku/{sku}/                 Create or update by SKU
 *   GET|PATCH|DELETE /api/v1/products/by-sku/{sku}/     Read, partly update, delete by SKU
 *   POST /api/v1/products/by-sku/{sku}/mark-as-sold/    A sale elsewhere
 *   POST /api/v1/products/by-sku/{sku}/purchase/        A test buyer buys it (staging only)
 *   ...  /api/v1/products/by-slug/{slug}/...            The same, by slug
 *   GET  /api/v1/orders/, /api/v1/orders/{purchase_id}/ Orders
 *   GET  /api/v1/shop/, /api/v1/shop/seller-addresses/, .../{address_id}/shipping-providers/
 *   GET  /status, /api-docs/openapi.yaml
 *
 * Signed webhooks (`X-Depop-Signature`) are produced with `webhook` and delivered with
 * `deliver`; a purchase delivers `v1:order.new` to `options.webhook` itself. Faults are injected
 * per action (`inject`): 429s (per seller or for the whole application), 5xx before and after
 * the change, refusals, revoked authorization, timeouts after the change was applied, held
 * requests, stale reads, and reads that can't see a new product yet. Depop's own rate limits are
 * enforced too. State lives in memory, outside the process under test, so it survives a worker
 * killed mid-call.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { DEPOP_EMAIL_ADDRESS } from '@listora/shared';

import { DEPOP_RATE_LIMITS, type RateWindow } from '../rate-limits.ts';
import { DEPOP_DEPARTMENTS } from '../taxonomy.ts';
import { depopWebhookSignature } from '../webhooks.ts';
import {
  FAKE_DEPOP_ADDRESS_ID,
  FAKE_DEPOP_CLIENT_ID,
  FAKE_DEPOP_CLIENT_SECRET,
  FAKE_DEPOP_REFRESH_TOKEN,
} from './constants.ts';
import { DEPOP_OPENAPI_PATH, loadDepopSpec, type DepopSpecOperation } from './spec.ts';

const ACCESS_TOKEN_SECONDS = 3600;
const GRANT_DAYS = 365;
const CODE_SECONDS = 600;
const PAGE_DEFAULT = 20;

/** What a request to the fake asked for. */
export type FakeDepopAction =
  | 'consent'
  | 'token'
  | 'put'
  | 'patch'
  | 'delete'
  | 'mark_sold'
  | 'get'
  | 'purchase'
  | 'orders'
  | 'order'
  | 'shop'
  | 'addresses'
  | 'shipping_providers'
  | 'status'
  | 'spec';

export type FakeDepopFault =
  /** HTTP 429 from Depop's gateway, optionally with `Retry-After`; nothing is applied. */
  | { type: 'rate_limited'; retryAfterSeconds?: number; scope?: 'seller' | 'application' }
  /** An HTTP 5xx; with `afterApply` the change is applied first. */
  | { type: 'server_error'; status?: 500 | 502 | 503 | 504; afterApply?: boolean }
  /** A 422 refusal (`validation` unless another code); nothing is applied. */
  | { type: 'reject'; code?: string; message?: string }
  /** The token is refused: 401 `unauthorized` from the API, `invalid_grant` from OAuth. */
  | { type: 'unauthorized' }
  /** Depop has disabled Listora's partner access: 401 `partner_access_denied`. */
  | { type: 'partner_access_denied' }
  /** The change is applied, and the answer comes after `delayMs` (after the client gave up). */
  | { type: 'timeout_after_send'; delayMs?: number }
  /** The request is held without an answer until the server closes. */
  | { type: 'hang'; afterApply: boolean }
  /** A read serves the product as it was before its latest change. */
  | { type: 'stale_read' }
  /** A read answers `product_not_found` for a product that exists, as just after creating it. */
  | { type: 'not_visible' };

export interface FakeDepopFaultRule {
  action: FakeDepopAction;
  fault: FakeDepopFault;
  /** Only requests about this SKU (or slug). */
  sku?: string;
  /** How many matching requests get the fault (default 1; `Infinity` for every one). */
  times?: number;
}

/** Chooses a fault (or none) for a request that no rule matched; see `setChaos`. */
export type FakeDepopFaultPicker = (request: {
  action: FakeDepopAction;
  sku: string | null;
}) => FakeDepopFault | undefined;

export interface FakeDepopRequest {
  action: FakeDepopAction;
  method: string;
  path: string;
  sku: string | null;
  fault: FakeDepopFault['type'] | null;
  /** Whether the request changed anything. */
  applied: boolean;
  /** The HTTP status sent, or `held` while a `hang` fault keeps it open. */
  status: number | 'held';
}

export interface FakeDepopOptions {
  port?: number;
  /** Accept photos at http URLs (local development serves them over http). */
  allowHttpPictures?: boolean;
  /** Depop's rate limits, smaller for tests; Depop's own by default. */
  rateLimits?: Partial<Record<'listingWrite' | 'other' | 'application', RateWindow>>;
  /** The redirect URIs registered for Listora's OAuth client; consent refuses any other. */
  redirectUris?: readonly string[];
  /**
   * Development only (`npm run dev:fake-depop`): the development seller's starting refresh token
   * keeps working, as if the seller consented again each time, so a restarted worker whose
   * configured token Depop would have rotated away still connects. Never in tests.
   */
  renewDevelopmentGrant?: boolean;
  /** Where a purchase sends its `v1:order.new` webhook, and the secret it is signed with. */
  webhook?: { url: string; secret: string };
  now?: () => Date;
}

/** The Depop Shipping options of a seller address. */
export interface FakeShippingProvider {
  id: string;
  parcelSizes: { id: string; title: string; costCents: number }[];
}

interface FakeAddress {
  id: number;
  state: string;
  country: string;
  providers: FakeShippingProvider[];
}

interface FakeSeller {
  userId: number;
  username: string;
  countryCode: string;
  currency: string;
  addresses: FakeAddress[];
}

interface FakeGrant {
  id: string;
  sellerId: number;
  scopes: string[];
  expiresAt: number;
  refreshToken: string;
  revoked: boolean;
}

/** A product as the fake keeps it. */
export interface FakeDepopProduct {
  productId: number;
  sellerId: number;
  sku: string | null;
  slug: string;
  status: string;
  /** The request fields it was created or last updated with (ProductPutRequest). */
  fields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** An order as the fake keeps it, in Depop's `Order` shape. */
export type FakeDepopOrder = Record<string, unknown> & { purchase_id: string; seller_id: number };

/** A signed webhook delivery, exactly as Depop sends it. */
export interface SignedDepopWebhook {
  body: string;
  /** Seconds since the epoch (`X-Depop-Timestamp`). */
  timestamp: string;
  /** `X-Depop-Signature`. */
  signature: string;
}

interface Reply {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface Auth {
  seller: FakeSeller;
  scopes: string[];
}

class Refusal extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** `onsale` statuses a product can change from. */
const DELETED_FROM: Readonly<Record<string, string>> = {
  STATUS_ONSALE: 'STATUS_DELETED_ONSALE',
  STATUS_PURCHASED: 'STATUS_DELETED_PURCHASED',
  STATUS_MARKED_AS_SOLD: 'STATUS_DELETED_MARKED_AS_SOLD',
};

const SCOPES = [
  'products_read',
  'products_write',
  'orders_read',
  'orders_write',
  'offers_read',
  'offers_write',
  'shop_read',
] as const;

export class FakeDepop {
  readonly #server: Server;
  readonly #options: FakeDepopOptions;
  readonly #sellers: FakeSeller[] = [];
  readonly #grants: FakeGrant[] = [];
  readonly #accessTokens = new Map<string, { grantId: string; expiresAt: number }>();
  readonly #codes = new Map<
    string,
    {
      sellerId: number;
      redirectUri: string;
      scopes: string[];
      challenge: string;
      expiresAt: number;
    }
  >();
  readonly #products: FakeDepopProduct[] = [];
  readonly #previous = new Map<number, FakeDepopProduct>();
  readonly #orders: FakeDepopOrder[] = [];
  readonly #faults: (FakeDepopFaultRule & { remaining: number })[] = [];
  readonly #requests: FakeDepopRequest[] = [];
  readonly #waiters = new Set<() => void>();
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly #sent = new Map<string, number[]>();
  readonly #specViolations: string[] = [];
  #consentSellerId: number;
  #denyConsent = false;
  #chaos: FakeDepopFaultPicker | undefined;
  #tokenRequests = 0;
  #nextProductId = 7_000_001;
  #nextPurchaseId = 435_017_000_001;
  #url = '';

  private constructor(options: FakeDepopOptions) {
    this.#options = options;
    this.#consentSellerId = this.addSeller({
      username: 'listora_dev_seller',
      refreshToken: FAKE_DEPOP_REFRESH_TOKEN,
    }).userId;
    this.#server = createServer((request, response) => {
      this.#handle(request, response).catch((error: unknown) => {
        send(
          response,
          json(500, {
            id: randomUUID(),
            errors: [{ code: 'generic_error', message: String(error) }],
          }),
        );
      });
    });
  }

  /** Starts the fake on 127.0.0.1, on `port` or else an ephemeral port. */
  static async start(options: FakeDepopOptions = {}): Promise<FakeDepop> {
    // Compiled before the first request, so that request is answered as quickly as any other.
    loadDepopSpec();
    const fake = new FakeDepop(options);
    await new Promise<void>((resolve, reject) => {
      fake.#server.once('error', reject);
      fake.#server.listen(options.port ?? 0, '127.0.0.1', () => {
        fake.#server.off('error', reject);
        resolve();
      });
    });
    fake.#url = `http://127.0.0.1:${String((fake.#server.address() as AddressInfo).port)}`;
    return fake;
  }

  /** The base URL of every Depop host (`DEPOP_FAKE_URL`). */
  get url(): string {
    return this.#url;
  }

  get requests(): readonly FakeDepopRequest[] {
    return this.#requests;
  }

  /** The development seller's id: the seller whose shop address `DEPOP_ENV=fake` ships from. */
  get developmentSellerId(): number {
    const seller = this.#sellers[0];
    if (seller === undefined) throw new Error('the fake always has its development seller');
    return seller.userId;
  }

  /** Requests to the token endpoint so far. */
  get tokenRequests(): number {
    return this.#tokenRequests;
  }

  /** Requests or responses that broke Depop's spec; a correct client and fake leave it empty. */
  get specViolations(): readonly string[] {
    return this.#specViolations;
  }

  // Sellers and grants -----------------------------------------------------------------------

  /**
   * Adds a seller with a US shop address that offers Depop Shipping, and a grant to Listora
   * with every scope; returns the seller's id and the grant's refresh token.
   */
  addSeller(options: { username?: string; refreshToken?: string; countryCode?: string } = {}): {
    userId: number;
    refreshToken: string;
  } {
    const userId = 97_082_934 + this.#sellers.length;
    const addressId = this.#sellers.length === 0 ? FAKE_DEPOP_ADDRESS_ID : 100_000 + userId;
    this.#sellers.push({
      userId,
      username: options.username ?? `fake_seller_${String(this.#sellers.length + 1)}`,
      countryCode: options.countryCode ?? 'US',
      currency: (options.countryCode ?? 'US') === 'GB' ? 'GBP' : 'USD',
      addresses: [
        {
          id: addressId,
          state: 'California',
          country: options.countryCode ?? 'US',
          providers: [
            {
              id: 'USPS',
              parcelSizes: [
                { id: 'SMALL', title: 'Small', costCents: 499 },
                { id: 'MEDIUM', title: 'Medium', costCents: 799 },
                { id: 'LARGE', title: 'Large', costCents: 1199 },
              ],
            },
          ],
        },
      ],
    });
    const refreshToken = this.#grant(userId, [...SCOPES], options.refreshToken).refreshToken;
    return { userId, refreshToken };
  }

  /** A new grant for a seller, as their consent gives one; returns its refresh token. */
  grant(userId: number, scopes: readonly string[] = SCOPES): string {
    return this.#grant(userId, [...scopes]).refreshToken;
  }

  /** The seller whose consent the consent page gives next (the development seller at first). */
  consentAs(userId: number): void {
    this.#consentSellerId = userId;
  }

  /** The next consent is denied (`error=access_denied`). */
  denyNextConsent(): void {
    this.#denyConsent = true;
  }

  /** The seller removes Listora's access: every grant and token of theirs stops working. */
  revokeSeller(userId: number): void {
    for (const grant of this.#grants) if (grant.sellerId === userId) grant.revoked = true;
  }

  /** Every access token issued so far expires now (refresh tokens keep working). */
  expireAccessTokens(): void {
    for (const token of this.#accessTokens.values()) token.expiresAt = 0;
  }

  // Products and orders ----------------------------------------------------------------------

  /** Every product, or the products with a SKU (or slug). */
  products(sku?: string): FakeDepopProduct[] {
    return this.#products
      .filter((product) => sku === undefined || product.sku === sku || product.slug === sku)
      .map((product) => structuredClone(product));
  }

  product(sku: string): FakeDepopProduct | undefined {
    return this.products(sku)[0];
  }

  /** The seller deletes the product in the Depop app. */
  deleteInApp(sku: string): void {
    const product = this.#productBy(sku);
    if (product === undefined) throw new Error(`no product ${sku}`);
    this.#change(product, { status: DELETED_FROM[product.status] ?? product.status });
  }

  /** Depop bans the product. */
  ban(sku: string): void {
    const product = this.#productBy(sku);
    if (product === undefined) throw new Error(`no product ${sku}`);
    this.#change(product, {
      status:
        product.status === 'STATUS_PURCHASED'
          ? 'STATUS_PRODUCT_BANNED_PURCHASED'
          : 'STATUS_PRODUCT_BANNED_ONSALE',
    });
  }

  /** A test buyer buys the product: it sells, the seller gets an order, and its webhook goes. */
  purchase(sku: string): FakeDepopOrder {
    const product = this.#productBy(sku);
    if (product?.status !== 'STATUS_ONSALE') throw new Error(`product ${sku} is not on sale`);
    return this.#purchase(product);
  }

  orders(): FakeDepopOrder[] {
    return this.#orders.map((order) => structuredClone(order));
  }

  // Webhooks ---------------------------------------------------------------------------------

  /** A webhook as Depop signs it: the envelope, its timestamp, and `X-Depop-Signature`. */
  webhook(
    eventType: string,
    data: unknown,
    options: { secret: string; id?: string; at?: Date },
  ): SignedDepopWebhook {
    const at = options.at ?? this.#now();
    const body = JSON.stringify({
      id: options.id ?? randomUUID(),
      event_type: eventType,
      created_at: at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      data,
    });
    const timestamp = String(Math.floor(at.getTime() / 1000));
    return { body, timestamp, signature: depopWebhookSignature(options.secret, timestamp, body) };
  }

  /** The `v1:order.new` webhook of an order. */
  orderWebhook(order: FakeDepopOrder, options: { secret: string; at?: Date }): SignedDepopWebhook {
    return this.webhook('v1:order.new', orderWebhookData(order), {
      ...options,
      id: purchaseEventId(order.purchase_id),
    });
  }

  /** POSTs a signed webhook to an endpoint; resolves with its status code. */
  async deliver(endpoint: string, webhook: SignedDepopWebhook): Promise<number> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-depop-signature': webhook.signature,
        'x-depop-timestamp': webhook.timestamp,
      },
      body: webhook.body,
    });
    await response.arrayBuffer();
    return response.status;
  }

  // Faults -----------------------------------------------------------------------------------

  inject(rule: FakeDepopFaultRule): void {
    this.#faults.push({ ...rule, remaining: rule.times ?? 1 });
  }

  /** Removes every fault rule and the chaos picker. */
  clearFaults(): void {
    this.#faults.length = 0;
    this.#chaos = undefined;
  }

  /** Picks faults for requests no rule matches, for randomized chaos runs. */
  setChaos(picker: FakeDepopFaultPicker | undefined): void {
    this.#chaos = picker;
  }

  /** Resolves with the first request matching `predicate`, waiting for it if needed. */
  waitForRequest(
    predicate: (request: FakeDepopRequest) => boolean,
    timeoutMs = 10_000,
  ): Promise<FakeDepopRequest> {
    return new Promise((resolve, reject) => {
      const check = (): void => {
        const match = this.#requests.find(predicate);
        if (match === undefined) return;
        cleanup();
        resolve(match);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('timed out waiting for a fake Depop request'));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.#waiters.delete(check);
      };
      this.#waiters.add(check);
      check();
    });
  }

  async close(): Promise<void> {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }

  // Requests ---------------------------------------------------------------------------------

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://fake.invalid');
    const body = await readBody(request);
    const method = request.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/settings/oauth/apps/') {
      this.#run(response, { action: 'consent', method, path: url.pathname, sku: null }, () =>
        this.#consent(url.searchParams),
      );
      return;
    }
    const matched = loadDepopSpec().match(method, url.pathname);
    if (matched === undefined) {
      send(response, json(404, errorBody('not_found', 'No such endpoint')));
      return;
    }
    const { operation, params } = matched;
    const route = this.#route(operation.operationId);
    if (route === undefined) {
      send(
        response,
        json(404, errorBody('not_found', `The fake doesn't serve ${operation.operationId}`)),
      );
      return;
    }
    const sku = params['sku'] ?? params['slug'] ?? null;
    const meta = { action: route.action, method, path: url.pathname, sku };
    this.#run(
      response,
      meta,
      (fault) => {
        try {
          const pathErrors = operation.pathErrors(params);
          if (pathErrors.length > 0) throw new Refusal(400, 'bad-request', pathErrors.join('; '));
          const auth = route.scope === null ? null : this.#auth(request, route.scope, fault);
          const input = parseInput(request, body);
          return this.#checked(operation, route.handle({ auth, params, url, input, fault }));
        } catch (error) {
          if (error instanceof Refusal) return this.#checked(operation, refusal(error));
          throw error;
        }
      },
      (fault) => {
        const failed = faultReply(fault, route.action, meta.sku);
        return failed === undefined ? undefined : this.#checked(operation, failed);
      },
    );
  }

  /** A response checked against Depop's spec; one that breaks it is a 500 and a violation. */
  #checked(operation: DepopSpecOperation, reply: Reply): Reply {
    if (!(reply.headers?.['content-type'] ?? 'application/json').startsWith('application/json')) {
      return reply;
    }
    const errors = operation.responseErrors(
      reply.status,
      reply.body === '' ? {} : JSON.parse(reply.body),
    );
    if (errors.length === 0) return reply;
    const violation = `${operation.operationId} ${String(reply.status)}: ${errors.join('; ')}`;
    this.#specViolations.push(violation);
    return json(500, errorBody('generic_error', `fake-depop broke Depop's spec: ${violation}`));
  }

  #route(operationId: string):
    | {
        action: FakeDepopAction;
        /** The OAuth scope the operation needs; `null` for an unauthenticated one. */
        scope: string | null;
        handle: (input: {
          auth: Auth | null;
          params: Record<string, string>;
          url: URL;
          input: unknown;
          fault: FakeDepopFault | undefined;
        }) => Reply;
      }
    | undefined {
    const seller = (auth: Auth | null): FakeSeller => {
      if (auth === null) throw new Error('an authenticated route has no seller');
      return auth.seller;
    };
    const ref = (params: Record<string, string>) =>
      params['sku'] === undefined
        ? { by: 'slug' as const, value: params['slug'] ?? '' }
        : { by: 'sku' as const, value: params['sku'] };
    switch (operationId) {
      case 'exchangeToken':
        return {
          action: 'token',
          scope: null,
          handle: ({ input, fault }) => this.#token(input, fault),
        };
      case 'createOrUpdateProduct':
      case 'updateProductBySlug':
        return {
          action: 'put',
          scope: 'products_write',
          handle: ({ auth, params, input }) => this.#put(seller(auth), ref(params), input),
        };
      case 'patchProduct':
      case 'patchProductBySlug':
        return {
          action: 'patch',
          scope: 'products_write',
          handle: ({ auth, params, input }) => this.#patch(seller(auth), ref(params), input),
        };
      case 'deleteProduct':
      case 'deleteProductBySlug':
        return {
          action: 'delete',
          scope: 'products_write',
          handle: ({ auth, params }) => this.#delete(seller(auth), ref(params)),
        };
      case 'markProductAsSold':
      case 'markProductAsSoldBySlug':
        return {
          action: 'mark_sold',
          scope: 'products_write',
          handle: ({ auth, params }) => this.#markSold(seller(auth), ref(params)),
        };
      case 'getProductBySku':
      case 'getProductBySlug':
        return {
          action: 'get',
          scope: 'products_read',
          handle: ({ auth, params, fault }) => this.#get(seller(auth), ref(params), fault),
        };
      case 'triggerPurchaseBySku':
        return {
          action: 'purchase',
          scope: 'products_write',
          handle: ({ auth, params }) => {
            const product = this.#owned(seller(auth), ref(params));
            if (product.status !== 'STATUS_ONSALE') {
              throw new Refusal(422, 'product_not_on_sale', 'Product is not on sale');
            }
            this.#purchase(product);
            return empty(200);
          },
        };
      case 'getAllOrders':
        return {
          action: 'orders',
          scope: 'orders_read',
          handle: ({ auth, url }) => this.#listOrders(seller(auth), url.searchParams),
        };
      case 'getOrderByPurchaseId':
        return {
          action: 'order',
          scope: 'orders_read',
          handle: ({ auth, params }) => {
            const order = this.#orders.find(
              (candidate) =>
                candidate.purchase_id === params['purchase_id'] &&
                candidate.seller_id === seller(auth).userId,
            );
            if (order === undefined) {
              throw new Refusal(404, 'purchase_id_not_found', 'No order with that purchase ID');
            }
            return json(200, order);
          },
        };
      case 'getSellerDetails':
        return {
          action: 'shop',
          scope: 'shop_read',
          handle: ({ auth }) => {
            const shop = seller(auth);
            return json(200, {
              id: shop.userId,
              username: shop.username,
              country_code: shop.countryCode,
            });
          },
        };
      case 'getSellerAddresses':
        return {
          action: 'addresses',
          scope: 'shop_read',
          handle: ({ auth }) =>
            json(200, {
              meta: { cursor: null, has_more: false },
              data: seller(auth).addresses.map((address) => ({
                id: address.id,
                name: seller(auth).username,
                address: '1 Market Street',
                city: 'San Francisco',
                state: address.state,
                postal_code: '94105',
                country: address.country,
                last_modified: '2026-01-15T10:30:00Z',
              })),
            }),
        };
      case 'getShippingProviders':
        return {
          action: 'shipping_providers',
          scope: 'shop_read',
          handle: ({ auth, params }) => {
            const address = seller(auth).addresses.find(
              (candidate) => String(candidate.id) === params['address_id'],
            );
            if (address === undefined) {
              throw new Refusal(
                404,
                'address_not_found',
                `Address with ID ${params['address_id'] ?? ''} not found`,
              );
            }
            return json(
              200,
              address.providers.map((provider) => ({
                id: provider.id,
                parcel_sizes: provider.parcelSizes.map((size) => ({
                  id: size.id,
                  title: size.title,
                  subtitle: size.title,
                  cost: {
                    original_amount: amount(size.costCents),
                    original_currency: seller(auth).currency,
                    amount: amount(size.costCents),
                    currency: seller(auth).currency,
                  },
                  courier_service: 'DROP_OFF',
                })),
              })),
            );
          },
        };
      case 'getStatus':
        return { action: 'status', scope: null, handle: () => json(200, { status: 'OK' }) };
      case 'getOpenAPISpec':
        return {
          action: 'spec',
          scope: null,
          handle: () => ({
            status: 200,
            body: readFileSync(DEPOP_OPENAPI_PATH, 'utf8'),
            headers: { 'content-type': 'application/yaml' },
          }),
        };
      default:
        return undefined;
    }
  }

  /** Runs one request with its fault: records it, applies it, and answers (or holds it). */
  #run(
    response: ServerResponse,
    meta: { action: FakeDepopAction; method: string; path: string; sku: string | null },
    apply: (fault: FakeDepopFault | undefined) => Reply,
    failureReply?: (fault: FakeDepopFault) => Reply | undefined,
  ): void {
    const record: FakeDepopRequest = { ...meta, fault: null, applied: false, status: 'held' };
    const fault = this.#takeFault(record);
    record.fault = fault?.type ?? null;
    const reply = (result: Reply): void => {
      record.status = result.status;
      send(response, result);
    };
    const applyAndRecord = (): Reply => {
      const result = apply(fault);
      record.applied = result.status < 300 && changes(meta.action);
      return result;
    };
    const finish = (): void => {
      this.#requests.push(record);
      for (const waiter of [...this.#waiters]) waiter();
    };

    switch (fault?.type) {
      case 'rate_limited':
      case 'reject':
      case 'unauthorized':
      case 'partner_access_denied': {
        // The token endpoint's refusal is its own (`invalid_grant`), which `apply` gives.
        const failed =
          (meta.action === 'token' ? undefined : failureReply?.(fault)) ?? apply(fault);
        finish();
        reply(failed);
        return;
      }
      case 'server_error': {
        if (fault.afterApply === true) applyAndRecord();
        finish();
        reply(
          failureReply?.(fault) ??
            json(
              fault.status ?? 503,
              errorBody('generic_error', 'An error has occurred. Please try again later.'),
            ),
        );
        return;
      }
      case 'timeout_after_send': {
        const result = applyAndRecord();
        finish();
        const timer = setTimeout(() => {
          this.#timers.delete(timer);
          reply(result);
        }, fault.delayMs ?? 60_000);
        this.#timers.add(timer);
        return;
      }
      case 'hang':
        if (fault.afterApply) applyAndRecord();
        finish();
        return;
      case 'stale_read':
      case 'not_visible':
      case undefined: {
        const result = applyAndRecord();
        finish();
        reply(result);
        return;
      }
    }
  }

  #takeFault(record: FakeDepopRequest): FakeDepopFault | undefined {
    const rule = this.#faults.find(
      (candidate) =>
        candidate.remaining > 0 &&
        candidate.action === record.action &&
        (candidate.sku === undefined || candidate.sku === record.sku),
    );
    if (rule === undefined) return this.#chaos?.(record);
    rule.remaining -= 1;
    return rule.fault;
  }

  // OAuth ------------------------------------------------------------------------------------

  #grant(sellerId: number, scopes: string[], refreshToken?: string): FakeGrant {
    const grant: FakeGrant = {
      id: randomUUID(),
      sellerId,
      scopes,
      expiresAt: this.#now().getTime() + GRANT_DAYS * 24 * 60 * 60 * 1000,
      refreshToken: refreshToken ?? token('prt'),
      revoked: false,
    };
    this.#grants.push(grant);
    return grant;
  }

  /** Depop's consent page: the seller approves (or denies), and the browser is redirected. */
  #consent(query: URLSearchParams): Reply {
    const redirectUri = query.get('redirect_uri') ?? '';
    const state = query.get('state') ?? '';
    const registered = this.#options.redirectUris ?? [];
    if (
      query.get('response_type') !== 'code' ||
      query.get('client_id') !== FAKE_DEPOP_CLIENT_ID ||
      !registered.includes(redirectUri)
    ) {
      // Depop shows an error page rather than redirecting to an unregistered address.
      return {
        status: 400,
        body: 'Invalid OAuth request',
        headers: { 'content-type': 'text/plain' },
      };
    }
    const scopes = (query.get('scope') ?? '').split(/[+ ]/).filter((scope) => scope !== '');
    const challenge = query.get('code_challenge') ?? '';
    let error: string | null = null;
    if (this.#denyConsent) {
      this.#denyConsent = false;
      error = 'access_denied';
    } else if (state === '' || challenge === '' || query.get('code_challenge_method') !== 'S256') {
      error = 'invalid_request';
    } else if (
      scopes.length === 0 ||
      scopes.some((scope) => !(SCOPES as readonly string[]).includes(scope))
    ) {
      error = 'invalid_scope';
    }
    const location = new URL(redirectUri);
    if (error !== null) {
      location.searchParams.set('error', error);
      location.searchParams.set(
        'error_description',
        error === 'access_denied'
          ? 'The resource owner denied the request'
          : 'The request is invalid',
      );
    } else {
      const code = randomBytes(32).toString('base64url');
      this.#codes.set(code, {
        sellerId: this.#consentSellerId,
        redirectUri,
        scopes,
        challenge,
        expiresAt: this.#now().getTime() + CODE_SECONDS * 1000,
      });
      location.searchParams.set('code', code);
    }
    location.searchParams.set('state', state);
    return {
      status: 302,
      body: '',
      headers: { location: location.toString(), 'content-type': 'text/plain' },
    };
  }

  /** The token endpoint: authorization code (with PKCE) and refresh token grants. */
  #token(input: unknown, fault: FakeDepopFault | undefined): Reply {
    this.#tokenRequests += 1;
    const form = (input ?? {}) as Record<string, string>;
    const operation = loadDepopSpec().operation('exchangeToken');
    if (operation.bodyErrors(form).length > 0) {
      return oauthError(
        400,
        'invalid_request',
        'The request is missing a required parameter, includes an invalid parameter value, includes a parameter more than once, or is otherwise malformed',
      );
    }
    if (
      form['client_id'] !== FAKE_DEPOP_CLIENT_ID ||
      form['client_secret'] !== FAKE_DEPOP_CLIENT_SECRET
    ) {
      return oauthError(401, 'client secret does not match', 'Depop OAuth2 error');
    }
    const now = this.#now().getTime();
    if (form['grant_type'] === 'authorization_code') {
      const code = this.#codes.get(form['code'] ?? '');
      this.#codes.delete(form['code'] ?? '');
      if (
        code === undefined ||
        code.expiresAt <= now ||
        code.redirectUri !== form['redirect_uri']
      ) {
        return oauthError(
          400,
          'invalid_grant',
          'Authorization code is invalid, expired, or has already been used',
        );
      }
      const verifier = form['code_verifier'] ?? '';
      if (
        !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
        createHash('sha256').update(verifier).digest('base64url') !== code.challenge
      ) {
        return oauthError(
          400,
          'invalid_request',
          'PKCE verification failed - code verifier does not match the stored code challenge',
        );
      }
      return this.#issue(this.#grant(code.sellerId, code.scopes));
    }
    const presented = form['refresh_token'] ?? '';
    let grant = this.#grants.find((candidate) => candidate.refreshToken === presented);
    if (
      grant === undefined &&
      this.#options.renewDevelopmentGrant === true &&
      presented === FAKE_DEPOP_REFRESH_TOKEN
    ) {
      const development = this.#sellers[0];
      if (development !== undefined)
        grant = this.#grant(development.userId, [...SCOPES], token('prt'));
    }
    if (
      grant === undefined ||
      grant.revoked ||
      grant.expiresAt <= now ||
      fault?.type === 'unauthorized'
    ) {
      return oauthError(
        400,
        'invalid_grant',
        'The refresh token is invalid, expired, revoked, or does not belong to the client',
      );
    }
    // "The previous Access Token and Refresh Token are immediately invalidated."
    for (const [accessToken, issued] of this.#accessTokens) {
      if (issued.grantId === grant.id) this.#accessTokens.delete(accessToken);
    }
    grant.refreshToken = token('prt');
    return this.#issue(grant);
  }

  #issue(grant: FakeGrant): Reply {
    const accessToken = token('pat');
    this.#accessTokens.set(accessToken, {
      grantId: grant.id,
      expiresAt: this.#now().getTime() + ACCESS_TOKEN_SECONDS * 1000,
    });
    return json(200, {
      access_token: accessToken,
      refresh_token: grant.refreshToken,
      expires_in: ACCESS_TOKEN_SECONDS,
      token_type: 'Bearer',
    });
  }

  /** The seller behind a bearer token, refused unless it is live and has `scope`. */
  #auth(request: IncomingMessage, scope: string, fault: FakeDepopFault | undefined): Auth {
    const header = request.headers.authorization ?? '';
    const accessToken = /^Bearer (\S+)$/.exec(header)?.[1];
    const issued = accessToken === undefined ? undefined : this.#accessTokens.get(accessToken);
    const grant = this.#grants.find((candidate) => candidate.id === issued?.grantId);
    const seller = this.#sellers.find((candidate) => candidate.userId === grant?.sellerId);
    if (
      issued === undefined ||
      grant === undefined ||
      seller === undefined ||
      grant.revoked ||
      issued.expiresAt <= this.#now().getTime() ||
      fault?.type === 'unauthorized'
    ) {
      throw new Refusal(401, 'unauthorized', 'invalid api key');
    }
    if (!grant.scopes.includes(scope)) {
      throw new Refusal(403, 'insufficient_scope', `Required scope: ${scope}`);
    }
    return { seller, scopes: grant.scopes };
  }

  // Products ---------------------------------------------------------------------------------

  #productBy(id: string, by: 'sku' | 'slug' | 'any' = 'any'): FakeDepopProduct | undefined {
    return this.#products.find(
      (product) => (by !== 'slug' && product.sku === id) || (by !== 'sku' && product.slug === id),
    );
  }

  /** The seller's product, or 404 `product_not_found`. */
  #owned(seller: FakeSeller, ref: { by: 'sku' | 'slug'; value: string }): FakeDepopProduct {
    const product = this.#productBy(ref.value, ref.by);
    if (product?.sellerId !== seller.userId) {
      throw new Refusal(
        404,
        'product_not_found',
        `Product (${ref.by}: ${ref.value}, id: None, slug: None) not found`,
      );
    }
    return product;
  }

  /** Create or update: the product fields, checked as Depop checks them. */
  #put(seller: FakeSeller, ref: { by: 'sku' | 'slug'; value: string }, input: unknown): Reply {
    this.#takeRate(seller, 'listingWrite');
    const fields = this.#productFields(
      seller,
      ref.by === 'sku' ? 'createOrUpdateProduct' : 'updateProductBySlug',
      input,
      ref.value,
    );
    const existing = this.#productBy(ref.value, ref.by);
    if (existing !== undefined && existing.sellerId !== seller.userId) {
      throw new Refusal(
        422,
        'duplicate_sku',
        `Failed to create or update product (sku: ${ref.value}) because that SKU already belongs to another product. SKUs must be unique.`,
      );
    }
    if (existing === undefined) {
      if (ref.by === 'slug') {
        throw new Refusal(404, 'product_not_found', `Product (slug: ${ref.value}) not found`);
      }
      const productId = this.#nextProductId;
      this.#nextProductId += 1;
      const now = timestamp(this.#now());
      const product: FakeDepopProduct = {
        productId,
        sellerId: seller.userId,
        sku: ref.value,
        slug: slugOf(String(fields['description']), productId),
        status: 'STATUS_ONSALE',
        fields,
        createdAt: now,
        updatedAt: now,
      };
      this.#products.push(product);
      return json(200, { product_id: productId, slug: product.slug, sku: product.sku });
    }
    if (existing.status.includes('BANNED')) {
      throw new Refusal(
        422,
        'product_has_been_banned',
        `Product (sku: ${existing.sku ?? ''}) has been banned`,
      );
    }
    if (existing.status !== 'STATUS_ONSALE') {
      // "creating a listing with a SKU that already exists (including on sold or deleted
      // products) fails with a duplicate-SKU error."
      throw new Refusal(
        422,
        'duplicate_sku',
        `Failed to create or update product (sku: ${existing.sku ?? ref.value}) because that SKU already belongs to another product. SKUs must be unique.`,
      );
    }
    if (
      existing.fields['size_id'] !== fields['size_id'] &&
      existing.fields['size_id'] !== undefined
    ) {
      throw new Refusal(422, 'validation', 'Existing product sizeId can not be changed');
    }
    this.#change(existing, { fields });
    return json(200, { product_id: existing.productId, slug: existing.slug, sku: existing.sku });
  }

  #patch(seller: FakeSeller, ref: { by: 'sku' | 'slug'; value: string }, input: unknown): Reply {
    this.#takeRate(seller, 'other');
    const operation = loadDepopSpec().operation(
      ref.by === 'sku' ? 'patchProduct' : 'patchProductBySlug',
    );
    if (typeof input !== 'object' || input === null)
      throw new Refusal(400, 'bad-request', 'invalid request');
    const errors = operation.bodyErrors(input);
    if (errors.length > 0) throw new Refusal(422, 'validation', errors.join('; '));
    const product = this.#owned(seller, ref);
    if (product.status !== 'STATUS_ONSALE') {
      throw new Refusal(422, 'product_not_on_sale', 'The product is not on sale.');
    }
    const patch = input as Record<string, unknown>;
    if (patch['price_amount'] !== undefined) checkPrice(patch['price_amount']);
    const quantity = patch['quantity'];
    if (typeof quantity === 'number' && (!Number.isInteger(quantity) || quantity < 0)) {
      throw new Refusal(
        422,
        'validation',
        `Requested quantity (${String(quantity)}) must not be negative`,
      );
    }
    this.#change(product, {
      fields: { ...product.fields, ...patch },
      ...(quantity === 0 ? { status: 'STATUS_MARKED_AS_SOLD' } : {}),
    });
    return empty(200);
  }

  /** Idempotent: "a successful response (200) even if the product doesn't exist". */
  #delete(seller: FakeSeller, ref: { by: 'sku' | 'slug'; value: string }): Reply {
    this.#takeRate(seller, 'other');
    const product = this.#productBy(ref.value, ref.by);
    if (product?.sellerId === seller.userId) {
      const deleted = DELETED_FROM[product.status];
      if (deleted !== undefined) this.#change(product, { status: deleted });
    }
    return empty(200);
  }

  /** "If the product is not in a selling state, this endpoint will still return successfully." */
  #markSold(seller: FakeSeller, ref: { by: 'sku' | 'slug'; value: string }): Reply {
    this.#takeRate(seller, 'other');
    const product = this.#owned(seller, ref);
    if (product.status === 'STATUS_ONSALE') {
      this.#change(product, {
        status: 'STATUS_MARKED_AS_SOLD',
        fields: { ...product.fields, quantity: 0 },
      });
    }
    return empty(200);
  }

  #get(
    seller: FakeSeller,
    ref: { by: 'sku' | 'slug'; value: string },
    fault: FakeDepopFault | undefined,
  ): Reply {
    this.#takeRate(seller, 'other');
    const product = this.#owned(seller, ref);
    if (fault?.type === 'not_visible') {
      throw new Refusal(
        404,
        'product_not_found',
        `Product (${ref.by}: ${ref.value}, id: None, slug: None) not found`,
      );
    }
    const shown =
      fault?.type === 'stale_read' ? (this.#previous.get(product.productId) ?? product) : product;
    return json(200, productView(shown));
  }

  /** The fields of a create or full update, refused where Depop refuses them. */
  #productFields(
    seller: FakeSeller,
    operationId: string,
    input: unknown,
    sku: string,
  ): Record<string, unknown> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Refusal(400, 'bad-request', 'invalid request');
    }
    const fields = input as Record<string, unknown>;
    const pictures = fields['pictures'];
    if (Array.isArray(pictures) && pictures.length > 8) {
      throw new Refusal(
        422,
        'too_many_pictures',
        `Failed to create or update product (sku: ${sku}) because too many pictures were provided. The maximum is 8 pictures.`,
      );
    }
    const errors = loadDepopSpec().operation(operationId).bodyErrors(fields);
    if (errors.length > 0) throw new Refusal(422, 'validation', errors.join('; '));

    const description = String(fields['description']);
    const hashtags = description.match(/#[^\s#]+/g)?.length ?? 0;
    if (hashtags > 5 || DEPOP_EMAIL_ADDRESS.test(description)) {
      throw new Refusal(
        422,
        'invalid_description',
        `Failed to create or update product (sku: ${sku}) due to invalid description. Use a maximum of 5 hashtags and only tag the brand your item belongs to.`,
      );
    }
    checkPrice(fields['price_amount']);
    if (fields['price_currency'] !== seller.currency) {
      throw new Refusal(422, 'validation', `Price currency must be ${seller.currency}`);
    }
    if (!(DEPOP_DEPARTMENTS as readonly unknown[]).includes(fields['department'])) {
      throw new Refusal(
        422,
        'invalid_department',
        `Failed to create or update product (sku: ${sku}) due to invalid category. Please ensure a valid department (gender) is provided.`,
      );
    }
    const quantity = fields['quantity'];
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
      throw new Refusal(422, 'validation', 'Quantity must be at least 1 when creating a listing');
    }
    if ((fields['size_set_id'] === undefined) !== (fields['size_id'] === undefined)) {
      throw new Refusal(
        422,
        'invalid_size',
        `Failed to create or update product (sku: ${sku}) due to invalid size. Please check the size configuration.`,
      );
    }
    for (const picture of Array.isArray(pictures) ? (pictures as { url?: unknown }[]) : []) {
      const url = typeof picture.url === 'string' ? picture.url : '';
      const allowed = this.#options.allowHttpPictures === true ? /^https?:\/\//i : /^https:\/\//i;
      if (!allowed.test(url)) {
        throw new Refusal(
          422,
          'ingest_picture_error',
          `We could not download the picture at ${url}`,
        );
      }
    }
    this.#checkShipping(seller, fields);
    return structuredClone(fields);
  }

  #checkShipping(seller: FakeSeller, fields: Record<string, unknown>): void {
    const shipping = fields['depop_shipping'] as
      { address_id: number; shipping_provider_id: string; parcel_size_id: string } | undefined;
    const national = fields['national_shipping_cost'];
    if ((shipping === undefined) === (national === undefined)) {
      throw new Refusal(
        422,
        'validation',
        'Either depop_shipping or national_shipping_cost must be provided',
      );
    }
    if (shipping === undefined) {
      if (seller.countryCode === 'US') {
        throw new Refusal(
          422,
          'manual_shipping_not_allowed',
          'Failed to create or update product because manual shipping is not allowed for this user.',
        );
      }
      return;
    }
    const address = seller.addresses.find((candidate) => candidate.id === shipping.address_id);
    if (address === undefined)
      throw new Refusal(422, 'generic_error', 'Address does not belong to this user');
    const provider = address.providers.find(
      (candidate) => candidate.id === shipping.shipping_provider_id,
    );
    if (provider?.parcelSizes.some((size) => size.id === shipping.parcel_size_id) !== true) {
      throw new Refusal(
        422,
        'validation',
        'The shipping provider or parcel size is not available for this address',
      );
    }
  }

  /** Changes a product, keeping its state before the change for stale reads. */
  #change(
    product: FakeDepopProduct,
    change: Partial<Pick<FakeDepopProduct, 'fields' | 'status'>>,
  ): void {
    this.#previous.set(product.productId, structuredClone(product));
    Object.assign(product, change, { updatedAt: timestamp(this.#now()) });
  }

  #purchase(product: FakeDepopProduct): FakeDepopOrder {
    this.#change(product, {
      status: 'STATUS_PURCHASED',
      fields: { ...product.fields, quantity: 0 },
    });
    const seller = this.#sellers.find((candidate) => candidate.userId === product.sellerId);
    const priceCents = cents(product.fields['price_amount']);
    const shippingCents = 499;
    const feeCents = Math.round(priceCents * 0.033) + 45;
    const purchaseId = String(this.#nextPurchaseId);
    this.#nextPurchaseId += 1;
    const order: FakeDepopOrder = {
      seller_id: product.sellerId,
      purchase_id: purchaseId,
      status: 'SHIPPING_PENDING',
      currency: seller?.currency ?? 'USD',
      buyer_pays_amount: amount(priceCents + shippingCents),
      seller_receives_amount: amount(priceCents - feeCents),
      buyer_shipping_price: amount(shippingCents),
      buyer_address: {
        name: 'Fake Buyer',
        address: '2 Mission Street',
        city: 'San Francisco',
        postal_code: '94105',
        state: 'California',
        country_code: 'US',
      },
      line_items: [
        {
          purchase_item_id: Number(purchaseId.slice(-7)),
          sku: product.sku,
          product_id: product.productId,
          slug: product.slug,
          parcel_id: randomUUID(),
          description: String(product.fields['description']),
          original_price: amount(priceCents),
          sold_price: amount(priceCents),
          sold_via_offers: false,
          image_url: pictureUrls(product)[0] ?? '',
        },
      ],
      seller_fee_breakdown: [
        { fee_type: 'PAYMENT_FEE', amount: amount(feeCents), currency: seller?.currency ?? 'USD' },
      ],
      created_at: timestamp(this.#now()),
    };
    this.#orders.unshift(order);
    const webhook = this.#options.webhook;
    if (webhook !== undefined) {
      void this.deliver(webhook.url, this.orderWebhook(order, { secret: webhook.secret })).catch(
        () => undefined,
      );
    }
    return structuredClone(order);
  }

  #listOrders(seller: FakeSeller, query: URLSearchParams): Reply {
    this.#takeRate(seller, 'other');
    const limit = Number(query.get('limit') ?? PAGE_DEFAULT);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Refusal(400, 'bad-request', 'limit must be from 1 to 200');
    }
    const from = query.get('from');
    const mine = this.#orders.filter(
      (order) =>
        order.seller_id === seller.userId && (from === null || String(order['created_at']) >= from),
    );
    const cursor = query.get('cursor');
    const start = cursor === null ? 0 : mine.findIndex((order) => order.purchase_id === cursor) + 1;
    const page = mine.slice(start, start + limit);
    const last = page.at(-1);
    return json(200, {
      meta: {
        ...(last === undefined ? {} : { cursor: last.purchase_id }),
        has_more: start + limit < mine.length,
      },
      data: page,
    });
  }

  // Rate limits ------------------------------------------------------------------------------

  /** Counts a request against the seller's and the application's allowance, or refuses it. */
  #takeRate(seller: FakeSeller, group: 'listingWrite' | 'other'): void {
    const limits = { ...DEPOP_RATE_LIMITS, ...this.#options.rateLimits };
    const now = this.#now().getTime();
    const windows = [
      {
        key: `${group}:${String(seller.userId)}`,
        limit: limits[group],
        who: `user id: ${String(seller.userId)}`,
      },
      { key: 'application', limit: limits.application, who: `client id: ${FAKE_DEPOP_CLIENT_ID}` },
    ];
    for (const { key, limit, who } of windows) {
      const sent = (this.#sent.get(key) ?? []).filter((at) => at > now - limit.windowMs);
      this.#sent.set(key, sent);
      if (sent.length >= limit.requests) {
        const retryAfter = Math.max(1, Math.ceil(((sent[0] ?? now) + limit.windowMs - now) / 1000));
        throw new RateLimited(limit.requests, retryAfter, who);
      }
    }
    for (const { key } of windows) this.#sent.get(key)?.push(now);
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }
}

class RateLimited extends Refusal {
  readonly limit: number;
  readonly retryAfterSeconds: number;
  readonly who: string;

  constructor(limit: number, retryAfterSeconds: number, who: string) {
    super(429, 'TOO_MANY_REQUESTS', 'Too many requests');
    this.limit = limit;
    this.retryAfterSeconds = retryAfterSeconds;
    this.who = who;
  }
}

/** A product as Depop's GET endpoints show it (`Product`). */
function productView(product: FakeDepopProduct): Record<string, unknown> {
  const { fields } = product;
  const price = String(fields['price_amount']);
  const optional = (name: string) => (fields[name] === undefined ? {} : { [name]: fields[name] });
  return {
    sku: product.sku,
    product_id: product.productId,
    slug: product.slug,
    status: product.status,
    address: fields['address'],
    description: fields['description'],
    price_currency: fields['price_currency'],
    price_amount: price,
    current_price: typeof fields['discount_price'] === 'string' ? fields['discount_price'] : price,
    ...optional('discount_price'),
    ...optional('national_shipping_cost'),
    ...optional('international_shipping_cost'),
    ...optional('depop_shipping'),
    quantity: fields['quantity'],
    pictures: pictureUrls(product).map((url) => ({ url, height: 1280, width: 1280 })),
    department: fields['department'],
    product_type: fields['product_type'],
    ...optional('size_set_id'),
    ...optional('size_id'),
    condition: fields['condition'],
    colour: fields['colour'] ?? [],
    style: fields['style'] ?? [],
    age: fields['age'] ?? [],
    source: fields['source'] ?? [],
    brand: fields['brand_name'],
    attributes: fields['attributes'] ?? {},
    is_boosted: fields['is_boosted'] ?? false,
    created_at: product.createdAt,
    updated_at: product.updatedAt,
  };
}

/** Depop hosts listing photos itself once it has fetched them. */
function pictureUrls(product: FakeDepopProduct): string[] {
  const pictures = Array.isArray(product.fields['pictures']) ? product.fields['pictures'] : [];
  return pictures.map(
    (_, index) =>
      `https://media-photos.depop.com/b0/${String(product.productId)}/fake_${String(product.productId)}/P${String(index)}.jpg`,
  );
}

/** The `v1:order.new` payload (`OrderWebhook`) of an order. */
function orderWebhookData(order: FakeDepopOrder): Record<string, unknown> {
  const fees = Array.isArray(order['seller_fee_breakdown'])
    ? (order['seller_fee_breakdown'] as { amount: string }[])
    : [];
  const address = order['buyer_address'] as Record<string, unknown>;
  const { country_code: country, ...rest } = address;
  return {
    seller_id: order.seller_id,
    purchase_id: order.purchase_id,
    status: order['status'],
    currency: order['currency'],
    buyer_pays_amount: order['buyer_pays_amount'],
    seller_receives_amount: order['seller_receives_amount'],
    fee_amount: amount(fees.reduce((total, fee) => total + cents(fee.amount), 0)),
    buyer_shipping_price: order['buyer_shipping_price'],
    buyer_address: { ...rest, country },
    line_items: order['line_items'],
  };
}

/** Order webhooks' id: "derived from the purchase ID, so it is stable per order". */
function purchaseEventId(purchaseId: string): string {
  const hex = createHash('sha256').update(`purchase:${purchaseId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A 429, a 5xx, or a refusal for an injected fault; `undefined` to apply the request. */
function faultReply(
  fault: FakeDepopFault,
  action: FakeDepopAction,
  sku: string | null,
): Reply | undefined {
  switch (fault.type) {
    case 'rate_limited':
      return rateLimitReply(
        30_000,
        fault.retryAfterSeconds,
        fault.scope === 'application' ? `client id: ${FAKE_DEPOP_CLIENT_ID}` : 'user id: 97082934',
      );
    case 'server_error':
      return json(
        fault.status ?? 503,
        errorBody('generic_error', 'An error has occurred. Please try again later.'),
      );
    case 'reject':
      return json(
        422,
        errorBody(
          fault.code ?? 'validation',
          fault.message ?? `Failed to create or update product (sku: ${sku ?? ''})`,
        ),
      );
    case 'unauthorized':
      return action === 'token'
        ? undefined
        : json(401, errorBody('unauthorized', 'invalid api key'));
    case 'partner_access_denied':
      return json(
        401,
        errorBody(
          'partner_access_denied',
          'API access for your partner account is currently disabled',
        ),
      );
    case 'timeout_after_send':
    case 'hang':
    case 'stale_read':
    case 'not_visible':
      return undefined;
  }
}

function rateLimitReply(limit: number, retryAfterSeconds: number | undefined, who: string): Reply {
  return {
    status: 429,
    body: JSON.stringify({
      error: 'TOO_MANY_REQUESTS',
      error_description: 'Too many requests',
      error_message: 'Too many requests. Please try again later.',
      message: 'Too many requests. Please try again later.',
      detail: `Too many requests made with ${who}.`,
      id: randomUUID(),
      code: 429,
    }),
    headers: {
      'content-type': 'application/json',
      'x-ratelimit-limit': String(limit),
      'x-ratelimit-remaining': '0',
      ...(retryAfterSeconds === undefined ? {} : { 'retry-after': String(retryAfterSeconds) }),
    },
  };
}

function refusal(error: Refusal): Reply {
  if (error instanceof RateLimited) {
    return rateLimitReply(error.limit, error.retryAfterSeconds, error.who);
  }
  return json(error.status, errorBody(error.code, error.message));
}

/** Whether an action can change state (for `FakeDepopRequest.applied`). */
function changes(action: FakeDepopAction): boolean {
  return ['put', 'patch', 'delete', 'mark_sold', 'purchase', 'token'].includes(action);
}

function checkPrice(value: unknown): void {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,2})?$/.test(value) || cents(value) < 100) {
    throw new Refusal(
      422,
      'validation',
      'The price must be at least 1.00, with up to 2 decimal places',
    );
  }
}

function cents(value: unknown): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  return match === null ? 0 : Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}

function amount(valueCents: number): string {
  return `${String(Math.floor(valueCents / 100))}.${String(valueCents % 100).padStart(2, '0')}`;
}

/** "vintage-nike-t-shirt-123456789": words of the description and the product id. */
function slugOf(description: string, productId: number): string {
  const words = description
    .toLowerCase()
    .replace(/#[^\s#]+/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '')
    .slice(0, 5);
  return [...words, String(productId)].join('-');
}

function timestamp(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function token(prefix: 'pat' | 'prt'): string {
  return `${prefix}_${randomBytes(20).toString('hex')}`;
}

function errorBody(code: string, message: string): Record<string, unknown> {
  return { id: randomUUID(), errors: [{ code, message }] };
}

function oauthError(status: number, error: string, detail: string): Reply {
  return json(status, {
    code: status,
    error,
    message: 'Depop OAuth2 error',
    detail,
    error_message: 'Depop OAuth2 error',
    error_description: detail,
    id: randomUUID(),
  });
}

function json(status: number, body: unknown): Reply {
  return { status, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
}

function empty(status: number): Reply {
  return { status, body: '', headers: { 'content-type': 'application/json' } };
}

/** A request's JSON or form body; `undefined` without one, `null` when it can't be parsed. */
function parseInput(request: IncomingMessage, body: string): unknown {
  if (body === '') return undefined;
  if ((request.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(body));
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function send(response: ServerResponse, reply: Reply): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(reply.status, reply.headers ?? {});
  response.end(reply.body);
}
