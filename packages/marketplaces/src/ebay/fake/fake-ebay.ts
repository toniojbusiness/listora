/**
 * `fake-ebay`: an HTTP server that speaks the subset of eBay's APIs Listora uses, for
 * development and tests (docs/architecture.md section 5). It follows eBay's documented
 * contract (request and response shapes, validation, error codes, and messages; README.md
 * cites every page) so the eBay adapter can be tested against every failure mode without a
 * credential:
 *
 *   GET  /oauth2/authorize                                  OAuth: the consent page
 *                                                           ("Agree and Continue", "Not now")
 *   POST /oauth2/authorize                                  the page's decision: redirects to
 *                                                           the RuName's accept or decline URL
 *   POST /identity/v1/oauth2/token                          OAuth: authorization-code,
 *                                                           refresh-token, and client-credentials
 *                                                           grants
 *   POST /identity/v1/oauth2/token/revoke                   OAuth: revoke a seller's grant
 *   GET  /commerce/identity/v1/user                         Commerce Identity: getUser
 *   POST /ws/api.dll                                        Trading API (trading.ts)
 *   POST /commerce/media/v1_beta/image/create_image_from_url  Media: copy a photo into EPS
 *   GET  /commerce/media/v1_beta/image/:id                  Media: getImage
 *   GET  /commerce/taxonomy/v1/get_default_category_tree_id Taxonomy (taxonomy.json fixtures)
 *   GET  /commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=...
 *   GET  /commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=...
 *   GET  /sell/fulfillment/v1/order                         Fulfillment: getOrders
 *   GET  /sell/fulfillment/v1/order/:id                     Fulfillment: getOrder
 *   GET  /sell/finances/v1/transaction?filter=orderId:{id}  Finances: an order's transactions
 *   GET  /developer/analytics/v1_beta/rate_limit/           Developer Analytics: Trading usage
 *   GET  /commerce/notification/v1/public_key/:id           Notification: the signing key
 *   ...  /commerce/notification/v1/{config,topic,destination,subscription}
 *                                                           Notification: subscriptions
 *                                                           (notification-api.ts)
 *   GET  /itm/:id                                           A listing's page (the view URL)
 *
 * Signed notifications (notifications.ts) are produced with `notification`, and delivered to
 * a subscriber with `deliver`. Once Listora subscribes, the fake also publishes eBay's own
 * events to the subscribed destinations, as eBay does: `ORDER_CONFIRMATION` on `sell`,
 * `LISTING` when a Trading call creates, revises, ends, or relists a listing,
 * `AUTHORIZATION_REVOCATION` on `revokeSeller`, and `MARKETPLACE_ACCOUNT_DELETION` on
 * `deleteUser` (`notifications.settled()` waits for those deliveries). Faults are injected per action (`inject`): 429s, 5xx before and
 * after the change, eBay system errors, refusals, expired or revoked authorization, the daily
 * call limit, timeouts after the change was applied, held requests, and stale reads. State
 * lives in memory, outside the process under test, so it survives a worker killed mid-call.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { TRADING_CALLS, type TradingCallName } from '../trading.ts';
import { TRADING_ERRORS } from '../trading-errors.ts';
import { parseXml, XmlParseError, type XmlNode } from '../xml.ts';
import {
  FAKE_EBAY_CLIENT_ID,
  FAKE_EBAY_CLIENT_SECRET,
  FAKE_EBAY_POLICIES,
  FAKE_EBAY_REFRESH_TOKEN,
  FAKE_EBAY_RU_NAME,
} from './constants.ts';
import { FakeNotificationApi } from './notification-api.ts';
import { NotificationSigner, type SignedNotification } from './notifications.ts';
import type { FakeAccessToken, FakeEbayListing, FakeOrder, FakeSeller } from './state.ts';
import { fakeCategory, suggestCategories } from './taxonomy.ts';
import {
  runStaleGetItem,
  runTradingCall,
  TradingFailure,
  tradingResponse,
  type TradingStore,
} from './trading.ts';

const ACCESS_TOKEN_SECONDS = 7200;

/** What a request to the fake asked for. */
export type FakeEbayAction =
  | 'authorize'
  | 'token'
  | 'revoke'
  | 'identity'
  | 'add'
  | 'verify'
  | 'revise'
  | 'end'
  | 'relist'
  | 'get_item'
  | 'get_seller_list'
  | 'media'
  | 'taxonomy'
  | 'orders'
  | 'finances'
  | 'rate_limits'
  | 'public_key'
  /** Notification API config, topic, destination, and subscription calls. */
  | 'notification';

const TRADING_ACTIONS = {
  AddFixedPriceItem: 'add',
  VerifyAddFixedPriceItem: 'verify',
  ReviseFixedPriceItem: 'revise',
  EndFixedPriceItem: 'end',
  RelistFixedPriceItem: 'relist',
  GetItem: 'get_item',
  GetSellerList: 'get_seller_list',
} as const satisfies Record<TradingCallName, FakeEbayAction>;

export type FakeEbayFault =
  /** HTTP 429 from eBay's gateway, optionally with `Retry-After`; nothing is applied. */
  | { type: 'rate_limited'; retryAfterSeconds?: number }
  /** An HTTP 5xx; with `afterApply` the change is applied first. */
  | { type: 'server_error'; status?: number; afterApply?: boolean }
  /** Trading `Failure` 10007 ("System error"), a `SystemError`; optionally after applying. */
  | { type: 'system_error'; afterApply?: boolean }
  /** eBay refuses the request as invalid (Trading error 37, REST 400); nothing is applied. */
  | { type: 'reject'; message?: string }
  /** The seller's authorization is invalid (Trading 931, REST 401, token `invalid_grant`). */
  | { type: 'unauthorized' }
  /** The access token expired (Trading 21917053); nothing is applied. */
  | { type: 'token_expired' }
  /** The application's daily call limit is reached (Trading 518); nothing is applied. */
  | { type: 'call_limit' }
  /** The change is applied, and the answer comes after `delayMs` (after the client gave up). */
  | { type: 'timeout_after_send'; delayMs?: number }
  /** The request is held without an answer until the server closes. */
  | { type: 'hang'; afterApply: boolean }
  /** GetItem serves the listing as it was before its latest change. */
  | { type: 'stale_read' };

export interface FakeEbayFaultRule {
  action: FakeEbayAction;
  fault: FakeEbayFault;
  /** Only requests about this seller SKU. */
  sku?: string;
  /** Only requests about this listing. */
  itemId?: string;
  /** How many matching requests get the fault (default 1; `Infinity` for every one). */
  times?: number;
}

/** Chooses a fault (or none) for a request that no rule matched; see `setChaos`. */
export type FakeEbayFaultPicker = (request: {
  action: FakeEbayAction;
  sku: string | null;
  itemId: string | null;
}) => FakeEbayFault | undefined;

export interface FakeEbayRequest {
  action: FakeEbayAction;
  sku: string | null;
  itemId: string | null;
  uuid: string | null;
  fault: FakeEbayFault['type'] | null;
  /** Whether the request changed anything. */
  applied: boolean;
  /** The HTTP status sent, or `held` while a `hang` fault keeps it open. */
  status: number | 'held';
}

export interface FakeEbayOptions {
  port?: number;
  /** Accept photos at http URLs (local development serves them over http; eBay never does). */
  allowHttpPictures?: boolean;
  /** The application's daily Trading call limit (eBay's default is 5,000). */
  tradingDailyLimit?: number;
  /**
   * How long after a change a `stale_read` fault can still serve the listing as it was before
   * (eBay's reads catch up within a short time). Default: no limit.
   */
  staleReadWindowMs?: number;
  /**
   * Where the consent page sends the browser: the fake RuName's "auth accepted" URL (Listora's
   * callback; default the local API's), and its "auth declined" URL (default: the accept URL
   * with `error=access_denied`).
   */
  consentRedirect?: { acceptUrl: string; declineUrl?: string };
  /**
   * Accept http notification destinations (local development and tests receive them on
   * 127.0.0.1; eBay accepts only https URLs that are not localhost).
   */
  allowHttpNotificationEndpoints?: boolean;
  now?: () => Date;
}

interface Reply {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

class RestFailure extends Error {
  readonly status: number;
  readonly errorId: number;

  constructor(status: number, errorId: number, message: string) {
    super(message);
    this.status = status;
    this.errorId = errorId;
  }
}

export class FakeEbay {
  readonly #server: Server;
  readonly #options: FakeEbayOptions;
  readonly #sellers: FakeSeller[] = [];
  readonly #tokens = new Map<string, FakeAccessToken>();
  readonly #listings: FakeEbayListing[] = [];
  readonly #previous = new Map<string, FakeEbayListing>();
  readonly #changedAt = new Map<string, number>();
  readonly #removed = new Set<string>();
  readonly #uuids = new Map<string, string>();
  readonly #eps = new Map<string, string>();
  readonly #orders: FakeOrder[] = [];
  readonly #codes = new Map<string, string>();
  readonly #faults: (FakeEbayFaultRule & { remaining: number })[] = [];
  readonly #requests: FakeEbayRequest[] = [];
  readonly #waiters = new Set<() => void>();
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly #signer = new NotificationSigner();
  readonly #notifications: FakeNotificationApi;
  #chaos: FakeEbayFaultPicker | undefined;
  /** When each refresh token from a code exchange expires (epoch ms). */
  readonly #refreshExpiry = new Map<string, number>();
  readonly #grantCounts = new Map<string, number>();
  #consentRedirect: { acceptUrl: string; declineUrl?: string };
  #signedInUserId = '';
  /** Delay before every token endpoint answer, to widen races in tests. */
  tokenDelayMs = 0;
  #tradingCalls = 0;
  #tradingWindowStart: number;
  #nextItem = 1;
  #url = '';

  private constructor(options: FakeEbayOptions) {
    this.#options = options;
    this.#tradingWindowStart = this.#now().getTime();
    this.#notifications = new FakeNotificationApi({
      signer: this.#signer,
      baseUrl: () => this.#url,
      now: () => this.#now(),
      allowHttpEndpoints: options.allowHttpNotificationEndpoints ?? false,
    });
    this.#consentRedirect = options.consentRedirect ?? {
      acceptUrl: 'http://127.0.0.1:3000/v1/connections/ebay/callback',
    };
    this.#signedInUserId = this.addSeller({
      username: 'listora_dev_seller',
      refreshToken: FAKE_EBAY_REFRESH_TOKEN,
    }).userId;
    this.#server = createServer((request, response) => {
      this.#handle(request, response).catch((error: unknown) => {
        send(response, {
          status: 500,
          body: JSON.stringify({ errors: [{ errorId: 0, message: String(error) }] }),
        });
      });
    });
  }

  /** Starts the fake on 127.0.0.1, on `port` or else an ephemeral port. */
  static async start(options: FakeEbayOptions = {}): Promise<FakeEbay> {
    const fake = new FakeEbay(options);
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

  /** The base URL every eBay host maps to (`EBAY_FAKE_URL`). */
  get url(): string {
    return this.#url;
  }

  get requests(): readonly FakeEbayRequest[] {
    return this.#requests;
  }

  /**
   * The Notification API's state: config, destinations, subscriptions, the deliveries made,
   * `publish` (deliver a topic's notification to its subscribers now), and `settled`.
   */
  get notifications(): FakeNotificationApi {
    return this.#notifications;
  }

  /** The id of the key notifications are signed with. */
  get notificationKeyId(): string {
    return this.#signer.keyId;
  }

  /** Trading calls counted against the daily limit in the current window. */
  get tradingCalls(): number {
    this.#rollTradingWindow();
    return this.#tradingCalls;
  }

  // Sellers ----------------------------------------------------------------------------------

  /** Adds a seller who granted Listora access; returns its user id and refresh token. */
  addSeller(options: { username?: string; refreshToken?: string } = {}): {
    userId: string;
    refreshToken: string;
  } {
    const refreshToken = options.refreshToken ?? `v^1.1#i^1#f^0#r^1#${randomUUID()}`;
    const userId = `fakeUser${String(this.#sellers.length + 1)}`;
    this.#sellers.push({
      userId,
      username: options.username ?? `fake_seller_${String(this.#sellers.length + 1)}`,
      refreshTokens: new Set([refreshToken]),
      policies: { ...FAKE_EBAY_POLICIES },
    });
    return { userId, refreshToken };
  }

  /**
   * The seller agrees on eBay's consent page: returns the authorization code eBay would put in
   * the accept URL's query (the authorization-code grant exchanges it once).
   */
  authorizationCode(refreshToken = FAKE_EBAY_REFRESH_TOKEN): string {
    const seller = this.#sellers.find((candidate) => candidate.refreshTokens.has(refreshToken));
    if (seller === undefined) throw new Error('no seller has that refresh token');
    const code = `v^1.1#i^1#f^0#I^3#p^3#r^1#fake-code-${randomUUID()}`;
    this.#codes.set(code, seller.userId);
    return code;
  }

  /** The seller signed in on the consent page from now on (default: the development seller). */
  signInAs(userId: string): void {
    if (!this.#sellers.some((seller) => seller.userId === userId)) {
      throw new Error(`no fake eBay seller ${userId}`);
    }
    this.#signedInUserId = userId;
  }

  /** The seller signed in on the consent page. */
  get signedInSeller(): { userId: string; username: string } {
    const seller = this.#sellers.find((candidate) => candidate.userId === this.#signedInUserId);
    if (seller === undefined) throw new Error('no seller is signed in');
    return { userId: seller.userId, username: seller.username };
  }

  /** Where the consent page sends the browser next (Listora's callback). */
  setConsentRedirect(redirect: { acceptUrl: string; declineUrl?: string }): void {
    this.#consentRedirect = redirect;
  }

  /**
   * What the consent page does when the signed-in seller decides, without a browser: the URL
   * eBay sends the browser to next (the accept URL with `state`, `code`, and `expires_in`, or
   * the decline URL). Throws for a consent URL eBay would refuse.
   */
  consent(authorizationUrl: string, decision: 'agree' | 'decline' = 'agree'): string {
    const query = new URL(authorizationUrl).searchParams;
    const problem = consentProblem(query);
    if (problem !== undefined) throw new Error(`invalid consent request: ${problem}`);
    return this.#decide(query, decision);
  }

  /**
   * The seller removes Listora in My eBay ("Third-party app access"): every grant they gave
   * stops working at once.
   */
  revokeSellerAccess(userId: string): void {
    const seller = this.#sellers.find((candidate) => candidate.userId === userId);
    if (seller === undefined) return;
    seller.refreshTokens.clear();
    for (const [token, grant] of this.#tokens) {
      if (grant.sellerUserId === userId) this.#tokens.delete(token);
    }
  }

  /** Every refresh token from a code exchange expires now (the 18-month limit). */
  expireRefreshTokens(): void {
    for (const token of this.#refreshExpiry.keys()) this.#refreshExpiry.set(token, 0);
  }

  /** Token endpoint requests of one grant type that reached the fake, faulted or not. */
  tokenGrants(grantType: 'authorization_code' | 'refresh_token' | 'client_credentials'): number {
    return this.#grantCounts.get(grantType) ?? 0;
  }

  /** Every code and token the fake issued, for tests that check none of them leaked. */
  issuedSecrets(): string[] {
    return [
      ...this.#codes.keys(),
      ...this.#tokens.keys(),
      ...this.#refreshExpiry.keys(),
      ...this.#sellers.flatMap((seller) => [...seller.refreshTokens]),
    ];
  }

  /** The seller revokes Listora's access: its refresh and access tokens stop working. */
  revokeSeller(refreshToken: string): void {
    const seller = this.#sellers.find((candidate) => candidate.refreshTokens.has(refreshToken));
    if (seller === undefined) return;
    this.#dropGrants(seller);
    this.#notifications.publishLater(
      'AUTHORIZATION_REVOCATION',
      {
        username: seller.username,
        userId: seller.userId,
        eiasToken: eiasTokenOf(seller.userId),
        revokeReason: 'REVOKED_BY_USER',
        revocationDate: this.#now().toISOString(),
      },
      null,
    );
  }

  /**
   * The eBay user closes their account and asks eBay to delete their data: their grants stop
   * working and every subscribed application gets `MARKETPLACE_ACCOUNT_DELETION`.
   */
  deleteUser(userId: string): void {
    const seller = this.#sellers.find((candidate) => candidate.userId === userId);
    if (seller === undefined) throw new Error(`no eBay user ${userId}`);
    this.#dropGrants(seller);
    this.#notifications.publishLater(
      'MARKETPLACE_ACCOUNT_DELETION',
      { username: seller.username, userId: seller.userId, eiasToken: eiasTokenOf(seller.userId) },
      null,
    );
  }

  #dropGrants(seller: FakeSeller): void {
    seller.refreshTokens.clear();
    for (const [token, grant] of this.#tokens) {
      if (grant.sellerUserId === seller.userId) this.#tokens.delete(token);
    }
  }

  /** Makes every access token issued so far expire now (refresh tokens keep working). */
  expireAccessTokens(): void {
    for (const grant of this.#tokens.values()) grant.expiresAt = 0;
  }

  // Listings ---------------------------------------------------------------------------------

  /** Every listing, or the listings with a seller SKU. */
  listings(sku?: string): FakeEbayListing[] {
    return this.#listings
      .filter((listing) => sku === undefined || listing.sku === sku)
      .map((listing) => structuredClone(listing));
  }

  listing(itemId: string): FakeEbayListing | undefined {
    const listing = this.#listings.find((candidate) => candidate.itemId === itemId);
    return listing === undefined ? undefined : structuredClone(listing);
  }

  /** eBay drops the listing (as it does long after a listing ends); GetItem answers 17. */
  remove(itemId: string): void {
    const index = this.#listings.findIndex((listing) => listing.itemId === itemId);
    if (index >= 0) this.#listings.splice(index, 1);
    this.#removed.add(itemId);
  }

  /** A buyer buys the listing: it ends with a sale and the seller gets an order. */
  sell(itemId: string, options: { buyer?: string; shipping?: string } = {}): FakeOrder {
    const listing = this.#listings.find((candidate) => candidate.itemId === itemId);
    if (listing?.status !== 'Active') throw new Error(`listing ${itemId} is not active`);
    this.#previous.set(itemId, { ...listing });
    this.#changedAt.set(itemId, this.#now().getTime());
    const now = this.#now().toISOString();
    Object.assign(listing, {
      quantitySold: listing.quantity,
      status: 'Completed',
      endTime: now,
    } satisfies Partial<FakeEbayListing>);
    const order: FakeOrder = {
      orderId: `${String(10 + this.#orders.length)}-${String(10000 + this.#orders.length)}-${String(
        20000 + this.#orders.length,
      )}`,
      sellerUserId: listing.sellerUserId,
      itemId,
      sku: listing.sku,
      title: listing.title,
      buyer: options.buyer ?? 'fake_buyer',
      priceValue: listing.price,
      currency: listing.currency,
      creationDate: now,
      lastModifiedDate: now,
      cancelState: 'NONE_REQUESTED',
      shippingValue: options.shipping ?? '0.0',
      shipByDate: new Date(this.#now().getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    };
    this.#orders.push(order);
    const seller = this.#sellers.find((candidate) => candidate.userId === listing.sellerUserId);
    this.#notifications.publishLater(
      'ORDER_CONFIRMATION',
      {
        user: { userId: listing.sellerUserId, username: seller?.username ?? '' },
        order: {
          orderId: order.orderId,
          orderLineItems: [
            { orderLineItemId: `${order.orderId}-1`, listingId: itemId, quantity: 1 },
          ],
        },
      },
      listing.sellerUserId,
    );
    return { ...order };
  }

  // Notifications ----------------------------------------------------------------------------

  /** A notification as eBay signs it (`topic` and its `data`). */
  notification(topic: string, data: Record<string, unknown>): SignedNotification {
    return this.#signer.sign(topic, data, { at: this.#now() });
  }

  /** POSTs a signed notification to a subscriber endpoint; resolves with its status code. */
  async deliver(endpoint: string, notification: SignedNotification): Promise<number> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ebay-signature': notification.signature,
      },
      body: notification.body,
    });
    await response.arrayBuffer();
    return response.status;
  }

  // Faults -----------------------------------------------------------------------------------

  inject(rule: FakeEbayFaultRule): void {
    this.#faults.push({ ...rule, remaining: rule.times ?? 1 });
  }

  /** Removes every fault rule and the chaos picker. */
  clearFaults(): void {
    this.#faults.length = 0;
    this.#chaos = undefined;
  }

  /** Picks faults for requests no rule matches, for randomized chaos runs. */
  setChaos(picker: FakeEbayFaultPicker | undefined): void {
    this.#chaos = picker;
  }

  /** Resolves with the first request matching `predicate`, waiting for it if needed. */
  waitForRequest(
    predicate: (request: FakeEbayRequest) => boolean,
    timeoutMs = 10_000,
  ): Promise<FakeEbayRequest> {
    return new Promise((resolve, reject) => {
      const check = (): void => {
        const match = this.#requests.find(predicate);
        if (match === undefined) return;
        cleanup();
        resolve(match);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('timed out waiting for a fake eBay request'));
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
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (method === 'GET' && path.startsWith('/itm/')) {
      send(response, this.#itemPage(decodeURIComponent(path.slice('/itm/'.length))));
      return;
    }
    if (path === '/oauth2/authorize' && (method === 'GET' || method === 'POST')) {
      this.#run(response, { action: 'authorize' }, () =>
        this.#authorize(method, method === 'POST' ? new URLSearchParams(body) : url.searchParams),
      );
      return;
    }
    if (method === 'POST' && path === '/identity/v1/oauth2/token') {
      const grant = new URLSearchParams(body).get('grant_type') ?? '';
      this.#grantCounts.set(grant, (this.#grantCounts.get(grant) ?? 0) + 1);
      if (this.tokenDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.tokenDelayMs));
      }
      this.#run(response, { action: 'token' }, (fault) => this.#token(request, body, fault));
      return;
    }
    if (method === 'POST' && path === '/identity/v1/oauth2/token/revoke') {
      this.#run(response, { action: 'revoke' }, () => this.#revoke(request, body));
      return;
    }
    if (method === 'POST' && path === '/ws/api.dll') {
      this.#trading(request, response, body);
      return;
    }
    const notificationPath = /^\/commerce\/notification\/v1(\/(?!public_key\/).*)$/.exec(path)?.[1];
    if (notificationPath !== undefined) {
      await this.#notificationCall(request, response, method, notificationPath, body);
      return;
    }
    const rest = this.#restRoute(method, path, url, body);
    if (rest === undefined) {
      send(response, restError(new RestFailure(404, 0, 'No such endpoint')));
      return;
    }
    this.#run(
      response,
      rest.meta,
      () => {
        try {
          const grant = this.#bearer(request, rest.needsSeller);
          return rest.handle(grant);
        } catch (error) {
          if (error instanceof RestFailure) return restError(error);
          throw error;
        }
      },
      restFault,
    );
  }

  /** Runs one request with its fault: records it, applies it, and answers (or holds it). */
  #run(
    response: ServerResponse,
    meta: {
      action: FakeEbayAction;
      sku?: string | null;
      itemId?: string | null;
      uuid?: string | null;
    },
    apply: (fault: FakeEbayFault | undefined) => Reply,
    failureReply?: (fault: FakeEbayFault) => Reply | undefined,
  ): void {
    const record: FakeEbayRequest = {
      action: meta.action,
      sku: meta.sku ?? null,
      itemId: meta.itemId ?? null,
      uuid: meta.uuid ?? null,
      fault: null,
      applied: false,
      status: 'held',
    };
    const fault = this.#takeFault(record);
    record.fault = fault?.type ?? null;
    const reply = (result: Reply): void => {
      record.status = result.status;
      send(response, result);
    };
    const applyAndRecord = (): Reply => {
      const result = apply(fault);
      record.applied = result.status < 300 && changes(meta.action) && !isFailureBody(result);
      return result;
    };
    const finish = (): void => {
      this.#requests.push(record);
      for (const waiter of [...this.#waiters]) waiter();
    };

    switch (fault?.type) {
      case 'rate_limited':
        finish();
        reply({
          status: 429,
          body: JSON.stringify({
            errors: [
              {
                errorId: 2001,
                domain: 'ACCESS',
                category: 'REQUEST',
                message: 'Too many requests.',
              },
            ],
          }),
          headers: {
            'content-type': 'application/json',
            ...(fault.retryAfterSeconds === undefined
              ? {}
              : { 'retry-after': String(fault.retryAfterSeconds) }),
          },
        });
        return;
      case 'server_error':
        if (fault.afterApply === true) applyAndRecord();
        finish();
        reply({
          status: fault.status ?? 503,
          body: 'Service Unavailable',
          headers: { 'content-type': 'text/plain' },
        });
        return;
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
      case 'system_error':
      case 'reject':
      case 'unauthorized':
      case 'token_expired':
      case 'call_limit': {
        if (fault.type === 'system_error' && fault.afterApply === true) applyAndRecord();
        const failed = failureReply?.(fault) ?? apply(fault);
        finish();
        reply(failed);
        return;
      }
      case 'stale_read':
      case undefined: {
        const result = applyAndRecord();
        finish();
        reply(result);
        return;
      }
    }
  }

  /**
   * A Notification API call. Faults: `rate_limited`, `server_error`, and the REST refusals
   * answer without applying anything; the timing faults answer like `server_error`.
   */
  async #notificationCall(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    path: string,
    body: string,
  ): Promise<void> {
    const record: FakeEbayRequest = {
      action: 'notification',
      sku: null,
      itemId: null,
      uuid: null,
      fault: null,
      applied: false,
      status: 'held',
    };
    const fault = this.#takeFault(record);
    record.fault = fault?.type ?? null;
    let reply: Reply;
    if (fault !== undefined) {
      reply =
        fault.type === 'rate_limited'
          ? restError(new RestFailure(429, 2001, 'Too many requests.'))
          : (restFault(fault) ?? { status: 503, body: 'Service Unavailable' });
    } else {
      try {
        const grant = this.#bearer(request, false);
        const answer = await this.#notifications.handle(method, path, body, grant.sellerUserId);
        reply =
          answer === undefined
            ? restError(new RestFailure(404, 0, 'No such endpoint'))
            : {
                status: answer.status,
                body: answer.body === undefined ? '' : JSON.stringify(answer.body),
                headers: {
                  ...(answer.body === undefined ? {} : { 'content-type': 'application/json' }),
                  ...answer.headers,
                },
              };
        record.applied = method !== 'GET' && reply.status < 300;
      } catch (error) {
        if (!(error instanceof RestFailure)) throw error;
        reply = restError(error);
      }
    }
    record.status = reply.status;
    this.#requests.push(record);
    for (const waiter of [...this.#waiters]) waiter();
    send(response, reply);
  }

  #takeFault(record: FakeEbayRequest): FakeEbayFault | undefined {
    const rule = this.#faults.find(
      (candidate) =>
        candidate.remaining > 0 &&
        candidate.action === record.action &&
        (candidate.sku === undefined || candidate.sku === record.sku) &&
        (candidate.itemId === undefined || candidate.itemId === record.itemId),
    );
    if (rule === undefined) return this.#chaos?.(record);
    rule.remaining -= 1;
    return rule.fault;
  }

  // OAuth ------------------------------------------------------------------------------------

  #authorize(method: string, query: URLSearchParams): Reply {
    const problem = consentProblem(query);
    if (problem !== undefined) {
      return {
        status: 400,
        body: `Invalid consent request: ${problem}`,
        headers: { 'content-type': 'text/plain' },
      };
    }
    if (method === 'GET') {
      return {
        status: 200,
        body: consentPage(query, this.signedInSeller.username),
        headers: { 'content-type': 'text/html; charset=utf-8' },
      };
    }
    const decision = query.get('decision') === 'agree' ? 'agree' : 'decline';
    return { status: 302, body: '', headers: { location: this.#decide(query, decision) } };
  }

  #decide(query: URLSearchParams, decision: 'agree' | 'decline'): string {
    const state = query.get('state');
    const { acceptUrl, declineUrl } = this.#consentRedirect;
    if (decision === 'decline') {
      const target = new URL(declineUrl ?? acceptUrl);
      if (declineUrl === undefined) target.searchParams.set('error', 'access_denied');
      if (state !== null) target.searchParams.set('state', state);
      return target.toString();
    }
    const code = `v^1.1#i^1#f^0#I^3#p^3#r^1#fake-code-${randomUUID()}`;
    this.#codes.set(code, this.#signedInUserId);
    const target = new URL(acceptUrl);
    if (state !== null) target.searchParams.set('state', state);
    target.searchParams.set('code', code);
    target.searchParams.set('expires_in', '299');
    return target.toString();
  }

  #revoke(request: IncomingMessage, body: string): Reply {
    const expected = `Basic ${Buffer.from(`${FAKE_EBAY_CLIENT_ID}:${FAKE_EBAY_CLIENT_SECRET}`).toString('base64')}`;
    if (request.headers.authorization !== expected) {
      return oauthError(401, 'invalid_client', 'Client authentication failed');
    }
    const token = new URLSearchParams(body).get('token') ?? '';
    // Revoking a refresh token revokes its grant and the access tokens issued from it; an
    // unknown or already revoked token is still a 200 with an empty body.
    for (const seller of this.#sellers) seller.refreshTokens.delete(token);
    for (const [access, grant] of this.#tokens) {
      if (access === token || grant.refreshToken === token) this.#tokens.delete(access);
    }
    return { status: 200, body: '' };
  }

  #token(request: IncomingMessage, body: string, fault: FakeEbayFault | undefined): Reply {
    const expected = `Basic ${Buffer.from(`${FAKE_EBAY_CLIENT_ID}:${FAKE_EBAY_CLIENT_SECRET}`).toString('base64')}`;
    if (request.headers.authorization !== expected) {
      return oauthError(401, 'invalid_client', 'client authentication failed');
    }
    const form = new URLSearchParams(body);
    const grant = form.get('grant_type');
    const issue = (
      sellerUserId: string | null,
      tokenType: string,
      refreshToken?: string,
    ): Reply => {
      const token = `v^1.1#i^1#p^3#fake-${randomUUID()}`;
      this.#tokens.set(token, {
        sellerUserId,
        expiresAt: this.#now().getTime() + ACCESS_TOKEN_SECONDS * 1000,
        ...(refreshToken === undefined ? {} : { refreshToken }),
      });
      return json(200, {
        access_token: token,
        expires_in: ACCESS_TOKEN_SECONDS,
        token_type: tokenType,
      });
    };
    if (grant === 'client_credentials') return issue(null, 'Application Access Token');
    if (grant === 'authorization_code') {
      const code = form.get('code') ?? '';
      const userId = this.#codes.get(code);
      this.#codes.delete(code);
      const seller = this.#sellers.find((candidate) => candidate.userId === userId);
      if (seller === undefined || (form.get('redirect_uri') ?? '') === '') {
        return oauthError(
          400,
          'invalid_grant',
          'the provided authorization grant code is invalid or was issued to another client',
        );
      }
      const refreshToken = `v^1.1#i^1#f^0#r^1#${randomUUID()}`;
      seller.refreshTokens.add(refreshToken);
      this.#refreshExpiry.set(refreshToken, this.#now().getTime() + 47_304_000_000);
      const issued = JSON.parse(
        issue(seller.userId, 'User Access Token', refreshToken).body,
      ) as Record<string, unknown>;
      return json(200, {
        ...issued,
        refresh_token: refreshToken,
        refresh_token_expires_in: 47_304_000,
      });
    }
    if (grant !== 'refresh_token') {
      return oauthError(
        400,
        'unsupported_grant_type',
        'grant type in request is not supported by the authorization server',
      );
    }
    const refreshToken = form.get('refresh_token') ?? '';
    const seller = this.#sellers.find((candidate) => candidate.refreshTokens.has(refreshToken));
    const expiry = this.#refreshExpiry.get(refreshToken);
    const expired = expiry !== undefined && expiry <= this.#now().getTime();
    if (seller === undefined || expired || fault?.type === 'unauthorized') {
      return oauthError(
        400,
        'invalid_grant',
        'the provided authorization refresh token is invalid or was issued to another client',
      );
    }
    return issue(seller.userId, 'User Access Token', refreshToken);
  }

  // Trading ----------------------------------------------------------------------------------

  #trading(request: IncomingMessage, response: ServerResponse, body: string): void {
    const callHeader = header(request, 'x-ebay-api-call-name') ?? '';
    const callName = TRADING_CALLS.find((name) => name === callHeader);
    let document: { name: string; node: XmlNode } | undefined;
    try {
      document = parseXml(body);
    } catch (error) {
      if (!(error instanceof XmlParseError)) throw error;
    }
    if (callName === undefined || document?.name !== `${callName}Request`) {
      send(response, { status: 200, body: unsupportedCall(callHeader), headers: xmlHeaders() });
      return;
    }
    const node = document.node;
    const item = (node['Item'] ?? {}) as XmlNode;
    const field = (container: XmlNode, name: string): string | null => {
      const value = container[name];
      return typeof value === 'string' ? value : null;
    };
    const itemId = field(item, 'ItemID') ?? field(node, 'ItemID');
    const sku =
      field(item, 'SKU') ?? field(node, 'SKU') ?? (itemId === null ? null : this.#skuOf(itemId));
    const meta = {
      action: TRADING_ACTIONS[callName],
      sku,
      itemId,
      uuid: field(item, 'UUID'),
    };
    const now = this.#now();
    const failure = (fault: FakeEbayFault): Reply | undefined => {
      const error = tradingFault(fault);
      return error === undefined
        ? undefined
        : { status: 200, body: tradingResponse(callName, now, [], error), headers: xmlHeaders() };
    };
    this.#run(
      response,
      meta,
      (fault) => {
        const answer = (
          failed?: TradingFailure,
          fields: Parameters<typeof tradingResponse>[2] = [],
        ) => ({
          status: 200,
          body: tradingResponse(callName, now, fields, failed),
          headers: xmlHeaders(),
        });
        const auth = this.#tradingSeller(request);
        if (auth instanceof TradingFailure) return answer(auth);
        if (!this.#takeTradingCall()) {
          return answer(
            new TradingFailure(
              TRADING_ERRORS.callLimit,
              'Call usage limit has been reached.',
              'Your application has exceeded usage limit on this call, please make call to GetAPIAccessRules to check your call usage.',
            ),
          );
        }
        try {
          const before = new Map(
            this.#listings.map((listing) => [listing.itemId, listing.status] as const),
          );
          const fields =
            fault?.type === 'stale_read' && callName === 'GetItem'
              ? runStaleGetItem(this.#store(), auth, node)
              : runTradingCall(this.#store(), auth, callName, node);
          this.#publishListingChanges(callName, auth, itemId, before);
          return answer(undefined, fields);
        } catch (error) {
          if (error instanceof TradingFailure) return answer(error);
          throw error;
        }
      },
      failure,
    );
  }

  /** `LISTING` notifications for what a successful Trading call changed. */
  #publishListingChanges(
    callName: TradingCallName,
    seller: FakeSeller,
    itemId: string | null,
    before: Map<string, FakeEbayListing['status']>,
  ): void {
    const publish = (listingId: string, reason: 'CREATED' | 'UPDATED' | 'ENDED'): void => {
      this.#notifications.publishLater(
        'LISTING',
        { listingId, reason, user: { userId: seller.userId, username: seller.username } },
        seller.userId,
      );
    };
    for (const listing of this.#listings) {
      if (listing.sellerUserId !== seller.userId) continue;
      const was = before.get(listing.itemId);
      if (was === undefined) publish(listing.itemId, 'CREATED');
      else if (was === 'Active' && listing.status !== 'Active') publish(listing.itemId, 'ENDED');
    }
    if (callName === 'ReviseFixedPriceItem' && itemId !== null && before.has(itemId)) {
      publish(itemId, 'UPDATED');
    }
  }

  #tradingSeller(request: IncomingMessage): FakeSeller | TradingFailure {
    const token = header(request, 'x-ebay-api-iaf-token');
    if (token === undefined) {
      return new TradingFailure(
        '930',
        'No Password and no token.',
        'No XML <RequestPassword> or <RequestToken> was found in XML Request.',
      );
    }
    const grant = this.#tokens.get(token);
    const seller =
      grant?.sellerUserId === undefined || grant.sellerUserId === null
        ? undefined
        : this.#sellers.find((candidate) => candidate.userId === grant.sellerUserId);
    if (grant === undefined || seller === undefined) {
      return new TradingFailure(
        TRADING_ERRORS.iafTokenInvalid,
        'Invalid IAF token.',
        'IAF token supplied is invalid.',
      );
    }
    if (grant.expiresAt <= this.#now().getTime()) {
      return new TradingFailure(
        TRADING_ERRORS.iafTokenExpired,
        'Expired IAF token.',
        'IAF token supplied is expired.',
      );
    }
    return seller;
  }

  #takeTradingCall(): boolean {
    this.#rollTradingWindow();
    const limit = this.#options.tradingDailyLimit ?? 5_000;
    if (this.#tradingCalls >= limit) return false;
    this.#tradingCalls += 1;
    return true;
  }

  #rollTradingWindow(): void {
    const day = 24 * 60 * 60 * 1000;
    const now = this.#now().getTime();
    if (now - this.#tradingWindowStart < day) return;
    this.#tradingWindowStart += Math.floor((now - this.#tradingWindowStart) / day) * day;
    this.#tradingCalls = 0;
  }

  #store(): TradingStore {
    return {
      now: () => this.#now(),
      listings: this.#listings,
      previous: this.#previous,
      changedAt: this.#changedAt,
      staleReadWindowMs: this.#options.staleReadWindowMs ?? Number.POSITIVE_INFINITY,
      removed: this.#removed,
      uuids: this.#uuids,
      nextItemId: () => String(110_000_000_000 + this.#nextItem++),
      epsUrls: new Set(this.#eps.values()),
      allowHttpPictures: this.#options.allowHttpPictures ?? false,
      viewItemUrl: (itemId) => `${this.#url}/itm/${itemId}`,
    };
  }

  #skuOf(itemId: string): string | null {
    return this.#listings.find((listing) => listing.itemId === itemId)?.sku ?? null;
  }

  // REST -------------------------------------------------------------------------------------

  #restRoute(
    method: string,
    path: string,
    url: URL,
    body: string,
  ):
    | {
        meta: { action: FakeEbayAction; sku?: string | null; itemId?: string | null };
        needsSeller: boolean;
        handle: (grant: FakeAccessToken) => Reply;
      }
    | undefined {
    if (method === 'GET' && path === '/commerce/identity/v1/user') {
      return {
        meta: { action: 'identity' },
        needsSeller: true,
        handle: (grant) => {
          const seller = this.#sellers.find((candidate) => candidate.userId === grant.sellerUserId);
          if (seller === undefined)
            throw new RestFailure(404, 140001, 'The requested user was not found.');
          return json(200, {
            userId: seller.userId,
            username: seller.username,
            accountType: 'INDIVIDUAL',
            registrationMarketplaceId: 'EBAY_US',
            status: 'CONFIRMED',
          });
        },
      };
    }
    if (method === 'POST' && path === '/commerce/media/v1_beta/image/create_image_from_url') {
      return {
        meta: { action: 'media' },
        needsSeller: true,
        handle: () => this.#createImage(body),
      };
    }
    const image = /^\/commerce\/media\/v1_beta\/image\/([^/]+)$/.exec(path);
    if (method === 'GET' && image?.[1] !== undefined) {
      const id = decodeURIComponent(image[1]);
      return {
        meta: { action: 'media' },
        needsSeller: true,
        handle: () => {
          const imageUrl = this.#eps.get(id);
          if (imageUrl === undefined)
            throw new RestFailure(404, 190001, 'The image was not found.');
          return json(200, { imageUrl, expirationDate: this.#expiration() });
        },
      };
    }
    if (method === 'GET' && path === '/commerce/taxonomy/v1/get_default_category_tree_id') {
      return {
        meta: { action: 'taxonomy' },
        needsSeller: false,
        handle: () => {
          if (url.searchParams.get('marketplace_id') !== 'EBAY_US') {
            throw new RestFailure(400, 62004, 'The specified marketplace ID is not supported.');
          }
          return json(200, { categoryTreeId: '0', categoryTreeVersion: '130' });
        },
      };
    }
    if (
      method === 'GET' &&
      path === '/commerce/taxonomy/v1/category_tree/0/get_category_suggestions'
    ) {
      return {
        meta: { action: 'taxonomy' },
        needsSeller: false,
        handle: () => {
          const query = url.searchParams.get('q') ?? '';
          if (query.trim() === '')
            throw new RestFailure(400, 62006, "The 'q' query parameter is required.");
          const suggestions = suggestCategories(query);
          if (suggestions.length === 0) return { status: 204, body: '' };
          return json(200, {
            categorySuggestions: suggestions.map((category) => ({
              category: { categoryId: category.categoryId, categoryName: category.categoryName },
              categoryTreeNodeAncestors: category.ancestors.map((name, index) => ({
                categoryName: name,
                categoryTreeNodeLevel: category.ancestors.length - index,
              })),
              categoryTreeNodeLevel: category.ancestors.length + 1,
              relevancy: 'HIGH',
            })),
            categoryTreeId: '0',
            categoryTreeVersion: '130',
          });
        },
      };
    }
    if (
      method === 'GET' &&
      path === '/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category'
    ) {
      return {
        meta: { action: 'taxonomy' },
        needsSeller: false,
        handle: () => {
          const category = fakeCategory(url.searchParams.get('category_id') ?? '');
          if (category === undefined) {
            throw new RestFailure(
              400,
              62005,
              'The specified category ID does not exist or is not a leaf category.',
            );
          }
          return json(200, {
            aspects: category.aspects.map((aspect) => ({
              localizedAspectName: aspect.name,
              aspectConstraint: {
                aspectDataType: 'STRING',
                aspectMode: aspect.mode,
                aspectRequired: aspect.required,
                aspectUsage: aspect.required ? 'RECOMMENDED' : 'OPTIONAL',
                aspectEnabledForVariations: false,
                itemToAspectCardinality: aspect.cardinality,
                aspectMaxLength: aspect.maxLength,
              },
              aspectValues: aspect.values.map((value) => ({ localizedValue: value })),
            })),
          });
        },
      };
    }
    if (method === 'GET' && path === '/sell/fulfillment/v1/order') {
      return {
        meta: { action: 'orders' },
        needsSeller: true,
        handle: (grant) => this.#getOrders(grant, url),
      };
    }
    const orderPath = /^\/sell\/fulfillment\/v1\/order\/([^/]+)$/.exec(path);
    if (method === 'GET' && orderPath?.[1] !== undefined) {
      const orderId = decodeURIComponent(orderPath[1]);
      return {
        meta: { action: 'orders' },
        needsSeller: true,
        handle: (grant) => {
          const order = this.#orders.find(
            (candidate) =>
              candidate.orderId === orderId && candidate.sellerUserId === grant.sellerUserId,
          );
          if (order === undefined) {
            throw new RestFailure(404, 32100, 'Order not found. Please check the order id.');
          }
          return json(200, this.#orderView(order));
        },
      };
    }
    if (method === 'GET' && path === '/sell/finances/v1/transaction') {
      return {
        meta: { action: 'finances' },
        needsSeller: true,
        handle: (grant) => this.#getTransactions(grant, url),
      };
    }
    if (method === 'GET' && path === '/developer/analytics/v1_beta/rate_limit') {
      return {
        meta: { action: 'rate_limits' },
        needsSeller: false,
        handle: () => this.#rateLimits(url),
      };
    }
    const key = /^\/commerce\/notification\/v1\/public_key\/([^/]+)$/.exec(path);
    if (method === 'GET' && key?.[1] !== undefined) {
      const id = decodeURIComponent(key[1]);
      return {
        meta: { action: 'public_key' },
        needsSeller: false,
        handle: () => {
          if (id !== this.#signer.keyId)
            throw new RestFailure(404, 195000, 'The public key was not found.');
          return json(200, this.#signer.publicKey());
        },
      };
    }
    return undefined;
  }

  #bearer(request: IncomingMessage, needsSeller: boolean): FakeAccessToken {
    const authorization = request.headers.authorization ?? '';
    const token = /^Bearer (.+)$/i.exec(authorization)?.[1];
    const grant = token === undefined ? undefined : this.#tokens.get(token);
    if (grant === undefined || grant.expiresAt <= this.#now().getTime()) {
      throw new RestFailure(
        401,
        1001,
        'Invalid access token. Check the value of the Authorization HTTP request header.',
      );
    }
    if (needsSeller && grant.sellerUserId === null) {
      throw new RestFailure(
        403,
        1100,
        'Access denied. Insufficient permissions to fulfill the request.',
      );
    }
    return grant;
  }

  #createImage(body: string): Reply {
    let imageUrl: unknown;
    try {
      imageUrl = (JSON.parse(body) as { imageUrl?: unknown }).imageUrl;
    } catch {
      imageUrl = undefined;
    }
    const scheme =
      this.#options.allowHttpPictures === true ? /^https?:\/\/\S+$/ : /^https:\/\/\S+$/;
    if (typeof imageUrl !== 'string' || !scheme.test(imageUrl)) {
      throw new RestFailure(
        400,
        190204,
        'No valid image can be downloaded from the provided imageUrl. Please refer to the documentation.',
      );
    }
    const id = `v1|${String(this.#eps.size + 1)}|${randomUUID().slice(0, 8)}`;
    const epsUrl = `https://i.ebayimg.test/fake/${encodeURIComponent(id)}/s-l1600.jpg`;
    this.#eps.set(id, epsUrl);
    return {
      status: 201,
      body: JSON.stringify({ imageUrl: epsUrl, expirationDate: this.#expiration() }),
      headers: {
        'content-type': 'application/json',
        location: `${this.#url}/commerce/media/v1_beta/image/${encodeURIComponent(id)}`,
      },
    };
  }

  #expiration(): string {
    return new Date(this.#now().getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  #getOrders(grant: FakeAccessToken, url: URL): Reply {
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const offset = Number(url.searchParams.get('offset') ?? '0');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new RestFailure(400, 30700, 'Invalid limit. Supported ranges 1 - 200.');
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RestFailure(400, 30700, 'Invalid offset.');
    }
    const filter = url.searchParams.get('filter') ?? '';
    const range = /(creationdate|lastmodifieddate):\[([^\]]*?)\.\.([^\]]*)\]/.exec(filter);
    const from = range?.[2] === undefined || range[2] === '' ? -Infinity : Date.parse(range[2]);
    const to = range?.[3] === undefined || range[3] === '' ? Infinity : Date.parse(range[3]);
    if (Number.isNaN(from) || Number.isNaN(to))
      throw new RestFailure(400, 30800, 'Invalid filter.');
    const field = range?.[1] === 'creationdate' ? 'creationDate' : 'lastModifiedDate';
    const matching = this.#orders.filter((order) => {
      if (order.sellerUserId !== grant.sellerUserId) return false;
      const time = Date.parse(order[field]);
      return time >= from && time <= to;
    });
    const page = matching.slice(offset, offset + limit);
    const href = `${this.#url}/sell/fulfillment/v1/order?${url.searchParams.toString()}`;
    const next = new URLSearchParams(url.searchParams);
    next.set('offset', String(offset + limit));
    return json(200, {
      href,
      total: matching.length,
      limit,
      offset,
      ...(offset + limit < matching.length
        ? { next: `${this.#url}/sell/fulfillment/v1/order?${next.toString()}` }
        : {}),
      orders: page.map((order) => this.#orderView(order)),
    });
  }

  /**
   * Finances `getTransactions` for `filter=orderId:{id}`: the order's `SALE` transaction with
   * the fees eBay charges most categories (13.6% of the item price and shipping, and the $0.30
   * or $0.40 per-order fee). An unknown order has no transactions.
   */
  #getTransactions(grant: FakeAccessToken, url: URL): Reply {
    const filter = url.searchParams.get('filter') ?? '';
    const orderId = /^orderId:\{([^}]+)\}$/.exec(filter)?.[1];
    if (orderId === undefined) throw new RestFailure(400, 135000, 'Invalid filter.');
    const order = this.#orders.find(
      (candidate) => candidate.orderId === orderId && candidate.sellerUserId === grant.sellerUserId,
    );
    if (order === undefined) return json(200, { total: 0, limit: 200, offset: 0 });
    const totalCents = Math.round((Number(order.priceValue) + Number(order.shippingValue)) * 100);
    const finalValue = Math.round(totalCents * 0.136);
    const perOrder = totalCents > 1000 ? 40 : 30;
    const money = (cents: number) => ({
      value: (cents / 100).toFixed(2),
      currency: order.currency,
    });
    return json(200, {
      total: 1,
      limit: 200,
      offset: 0,
      transactions: [
        {
          transactionId: `SALE-${order.orderId}`,
          orderId: order.orderId,
          transactionType: 'SALE',
          transactionStatus: 'FUNDS_PROCESSING',
          transactionDate: order.creationDate,
          bookingEntry: 'CREDIT',
          amount: money(totalCents - finalValue - perOrder),
          totalFeeAmount: money(finalValue + perOrder),
          orderLineItems: [
            {
              lineItemId: `${order.orderId}-1`,
              feeBasisAmount: money(totalCents),
              marketplaceFees: [
                { feeType: 'FINAL_VALUE_FEE', amount: money(finalValue) },
                { feeType: 'FINAL_VALUE_FEE_FIXED_PER_ORDER', amount: money(perOrder) },
              ],
            },
          ],
        },
      ],
    });
  }

  /** An order as `getOrder` and `getOrders` answer it (`Order` in eBay's OpenAPI document). */
  #orderView(order: FakeOrder): Record<string, unknown> {
    const seller = this.#sellers.find((candidate) => candidate.userId === order.sellerUserId);
    const amount = { value: order.priceValue, currency: order.currency };
    const shipping = { value: order.shippingValue, currency: order.currency };
    const sum = Math.round((Number(order.priceValue) + Number(order.shippingValue)) * 100) / 100;
    // eBay echoes amounts with at least one decimal (`20.0`, `24.99`).
    const total = {
      value: sum.toFixed(Number.isInteger(sum * 10) ? 1 : 2),
      currency: order.currency,
    };
    return {
      orderId: order.orderId,
      legacyOrderId: order.orderId,
      creationDate: order.creationDate,
      lastModifiedDate: order.lastModifiedDate,
      orderFulfillmentStatus: 'NOT_STARTED',
      orderPaymentStatus: 'PAID',
      sellerId: seller?.username ?? '',
      buyer: { username: order.buyer },
      pricingSummary: { priceSubtotal: amount, deliveryCost: shipping, total },
      cancelStatus: { cancelState: order.cancelState, cancelRequests: [] },
      lineItems: [
        {
          lineItemId: `${order.orderId}-1`,
          legacyItemId: order.itemId,
          ...(order.sku === null ? {} : { sku: order.sku }),
          title: order.title,
          quantity: 1,
          lineItemCost: amount,
          total: amount,
          soldFormat: 'FIXED_PRICE',
          listingMarketplaceId: 'EBAY_US',
          purchaseMarketplaceId: 'EBAY_US',
          lineItemFulfillmentStatus: 'NOT_STARTED',
          lineItemFulfillmentInstructions: {
            shipByDate: order.shipByDate,
            guaranteedDelivery: false,
          },
        },
      ],
    };
  }

  #rateLimits(url: URL): Reply {
    const context = url.searchParams.get('api_context');
    if (context !== null && context !== 'tradingapi') return { status: 204, body: '' };
    this.#rollTradingWindow();
    const limit = this.#options.tradingDailyLimit ?? 5_000;
    const reset = new Date(this.#tradingWindowStart + 24 * 60 * 60 * 1000).toISOString();
    return json(200, {
      rateLimits: [
        {
          apiContext: 'TradingAPI',
          apiName: 'TradingAPI',
          apiVersion: 'v1',
          resources: [
            {
              name: 'TradingAPI',
              rates: [
                {
                  count: this.#tradingCalls,
                  limit,
                  remaining: Math.max(0, limit - this.#tradingCalls),
                  reset,
                  timeWindow: 86_400,
                },
              ],
            },
          ],
        },
      ],
    });
  }

  #itemPage(itemId: string): Reply {
    const listing = this.#listings.find((candidate) => candidate.itemId === itemId);
    if (listing === undefined)
      return { status: 404, body: 'Not found', headers: { 'content-type': 'text/plain' } };
    const escape = (value: string): string =>
      value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return {
      status: 200,
      body: `<!doctype html><title>${escape(listing.title)}</title><h1>${escape(listing.title)}</h1><p>US $${escape(listing.price)} - ${listing.status} (fake eBay listing ${escape(itemId)})</p>`,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    };
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }
}

/** The Trading error a fault answers with, when it is one eBay sends in a Trading document. */
function tradingFault(fault: FakeEbayFault): TradingFailure | undefined {
  switch (fault.type) {
    case 'system_error':
      return new TradingFailure(
        TRADING_ERRORS.systemError,
        'System error.',
        'System error. Unable to process your request. Please try again later.',
        { classification: 'SystemError' },
      );
    case 'reject':
      return new TradingFailure(
        TRADING_ERRORS.invalidInput,
        'Input data is invalid.',
        fault.message ??
          'Input data for tag <Item> is invalid or missing. Please check API documentation.',
      );
    case 'unauthorized':
      return new TradingFailure(
        TRADING_ERRORS.authTokenInvalid,
        'Auth token is invalid.',
        'Validation of the authentication token in API request failed.',
      );
    case 'token_expired':
      return new TradingFailure(
        TRADING_ERRORS.iafTokenExpired,
        'Expired IAF token.',
        'IAF token supplied is expired.',
      );
    case 'call_limit':
      return new TradingFailure(
        TRADING_ERRORS.callLimit,
        'Call usage limit has been reached.',
        'Your application has exceeded usage limit on this call, please make call to GetAPIAccessRules to check your call usage.',
      );
    case 'rate_limited':
    case 'server_error':
    case 'timeout_after_send':
    case 'hang':
    case 'stale_read':
      return undefined;
  }
}

/** The REST error a fault answers with (eBay's `errors[]` envelope). */
function restFault(fault: FakeEbayFault): Reply | undefined {
  switch (fault.type) {
    case 'unauthorized':
    case 'token_expired':
      return restError(
        new RestFailure(
          401,
          1001,
          'Invalid access token. Check the value of the Authorization HTTP request header.',
        ),
      );
    case 'reject':
      return restError(new RestFailure(400, 2004, fault.message ?? 'Invalid request.'));
    case 'system_error':
      return restError(new RestFailure(500, 2003, 'Internal error.'));
    case 'call_limit':
      return restError(
        new RestFailure(429, 2001, 'The request limit has been reached for the resource.'),
      );
    case 'rate_limited':
    case 'server_error':
    case 'timeout_after_send':
    case 'hang':
    case 'stale_read':
      return undefined;
  }
}

/** Whether a successful request of this kind changes anything. */
function changes(action: FakeEbayAction): boolean {
  return (
    action === 'add' ||
    action === 'revise' ||
    action === 'end' ||
    action === 'relist' ||
    action === 'media'
  );
}

function isFailureBody(reply: Reply): boolean {
  return reply.body.includes('<Ack>Failure</Ack>');
}

function unsupportedCall(callName: string): string {
  return tradingResponse(
    'GetItem',
    new Date(),
    [],
    new TradingFailure(
      '2',
      'Unsupported API call.',
      `The API call "${callName}" is invalid or not supported in this release.`,
    ),
  ).replaceAll('GetItemResponse', `${callName === '' ? 'Unknown' : callName}Response`);
}

/** A stand-in for eBay's legacy EIAS token of a user. */
function eiasTokenOf(userId: string): string {
  return Buffer.from(`eias:${userId}`).toString('base64');
}

function restError(error: RestFailure): Reply {
  return json(error.status, {
    errors: [
      {
        errorId: error.errorId,
        domain: 'API_FAKE',
        category: error.status >= 500 ? 'APPLICATION' : 'REQUEST',
        message: error.message,
        longMessage: error.message,
      },
    ],
  });
}

/** Why eBay's consent page would refuse a request, or undefined when it is valid. */
function consentProblem(query: URLSearchParams): string | undefined {
  if (query.get('client_id') !== FAKE_EBAY_CLIENT_ID) return 'unknown client_id';
  if (query.get('redirect_uri') !== FAKE_EBAY_RU_NAME) return 'unknown redirect_uri';
  if (query.get('response_type') !== 'code') return 'response_type must be code';
  if ((query.get('scope') ?? '') === '') return 'scope is required';
  return undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${String(char.charCodeAt(0))};`);
}

/** eBay's "Grant Application Access" page, reduced to its two buttons. */
function consentPage(query: URLSearchParams, username: string): string {
  const hidden = [...query.entries()]
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grant application access | Fake eBay</title>
<style>
  :root { color-scheme: light dark; font-family: -apple-system, system-ui, sans-serif; }
  body { margin: 0; padding: 32px 24px; max-width: 480px; margin-inline: auto; line-height: 1.45; }
  h1 { font-size: 24px; margin: 0 0 8px; }
  p { margin: 0 0 16px; }
  .seller { font-weight: 600; }
  button { display: block; width: 100%; font: inherit; font-size: 17px; font-weight: 600;
    padding: 14px; border-radius: 24px; margin-top: 12px; cursor: pointer; }
  .agree { background: #3665f3; color: #fff; border: none; }
  .decline { background: transparent; color: inherit; border: 1px solid currentColor; }
</style>
</head>
<body>
<p>Fake eBay (development)</p>
<h1>Listora wants access to your eBay account</h1>
<p>Signed in as <span class="seller">${escapeHtml(username)}</span>.</p>
<p>Listora will be able to list, revise, and end your items, and read your orders.</p>
<form method="post" action="/oauth2/authorize">${hidden}
<button class="agree" type="submit" name="decision" value="agree">Agree and Continue</button>
<button class="decline" type="submit" name="decision" value="decline">Not now</button>
</form>
</body>
</html>
`;
}

function oauthError(status: number, error: string, description: string): Reply {
  return json(status, { error, error_description: description });
}

function json(status: number, body: unknown): Reply {
  return { status, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
}

function xmlHeaders(): Record<string, string> {
  return { 'content-type': 'text/xml; charset=utf-8' };
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function send(response: ServerResponse, reply: Reply): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(reply.status, reply.headers);
  response.end(reply.body);
}
