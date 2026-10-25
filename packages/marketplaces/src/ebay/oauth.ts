/**
 * eBay OAuth 2.0 (https://developer.ebay.com/api-docs/static/oauth-tokens.html): the token
 * endpoint's refresh-token grant for a seller's user access token, and the client-credentials
 * grant for the application token some REST APIs take (Taxonomy, Developer Analytics).
 *
 * Tokens never reach logs, excerpts, or error messages. A token source caches each access
 * token until shortly before it expires and refreshes it single-flight, so concurrent calls
 * for one seller cause one refresh. The shared refresh belongs to no caller: it runs under the
 * OAuth client's own request timeout, so one caller's deadline or abort never fails the others,
 * and each caller stops waiting when its own signal aborts.
 */
import type { ConnectionRef } from '../adapter.ts';
import { requestText } from '../http.ts';

/** The scope of the application token (client-credentials grant). */
export const EBAY_APPLICATION_SCOPE = 'https://api.ebay.com/oauth/api_scope';

/**
 * The scopes Listora asks a seller to grant: the Trading API calls accept any user token,
 * Media needs `sell.inventory`, Fulfillment `sell.fulfillment`, and notification
 * subscriptions `commerce.notification.subscription`.
 */
export const EBAY_USER_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/commerce.notification.subscription',
] as const;

/** The seller must connect eBay again: the grant was revoked, expired, or never existed. */
export class EbayReauthRequiredError extends Error {
  constructor(message = "Listora's access to eBay has expired.") {
    super(message);
    this.name = 'EbayReauthRequiredError';
  }
}

/** eBay's token endpoint could not answer now; trying again later may work. */
export class EbayTokenUnavailableError extends Error {
  /** Why: a transport code (`timeout`, `ECONNREFUSED`) or `http_<status>`. */
  readonly code: string;

  constructor(code: string) {
    super(`eBay's sign-in service is unavailable (${code}).`);
    this.name = 'EbayTokenUnavailableError';
    this.code = code;
  }
}

export interface AccessToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface EbayOAuthClientOptions {
  /** `https://api.ebay.com/identity/v1/oauth2/token` (or the sandbox's, or the fake's). */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
  now?: () => number;
}

export class EbayOAuthClient {
  readonly #options: EbayOAuthClientOptions;
  readonly #now: () => number;

  constructor(options: EbayOAuthClientOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** How long one token endpoint request may take. */
  get timeoutMs(): number {
    return this.#options.timeoutMs ?? 10_000;
  }

  /** A user access token from a seller's refresh token (no scopes: the ones consented to). */
  refreshUserToken(
    refreshToken: string,
    scopes: readonly string[],
    signal: AbortSignal,
  ): Promise<AccessToken> {
    return this.#grant(
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        // Without a scope eBay grants what the seller consented to, which can't be refused.
        ...(scopes.length === 0 ? {} : { scope: scopes.join(' ') }),
      },
      signal,
    );
  }

  /**
   * The tokens for a seller's consent (authorization-code grant): `redirectUri` is the RuName
   * the consent URL used. The refresh token lasts about 18 months.
   */
  async exchangeAuthorizationCode(
    code: string,
    redirectUri: string,
    signal: AbortSignal,
  ): Promise<{ accessToken: AccessToken; refreshToken: string; refreshExpiresAt: number }> {
    const started = this.#now();
    const body = await this.#post(
      { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
      signal,
    );
    const refreshToken = body['refresh_token'];
    const refreshExpiresIn = body['refresh_token_expires_in'];
    if (typeof refreshToken !== 'string' || typeof refreshExpiresIn !== 'number') {
      throw new EbayTokenUnavailableError('malformed_token_response');
    }
    return {
      accessToken: accessTokenOf(body, started),
      refreshToken,
      refreshExpiresAt: started + refreshExpiresIn * 1000,
    };
  }

  /** An application access token (client-credentials grant). */
  applicationToken(scopes: readonly string[], signal: AbortSignal): Promise<AccessToken> {
    return this.#grant({ grant_type: 'client_credentials', scope: scopes.join(' ') }, signal);
  }

  async #grant(fields: Record<string, string>, signal: AbortSignal): Promise<AccessToken> {
    const started = this.#now();
    return accessTokenOf(await this.#post(fields, signal), started);
  }

  /** One token endpoint request; the answer's JSON when it succeeded. */
  async #post(
    fields: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const { clientId, clientSecret, tokenUrl } = this.#options;
    const result = await requestText({
      method: 'POST',
      url: tokenUrl,
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams(fields).toString(),
      signal,
      timeoutMs: this.timeoutMs,
    });
    if (result.type !== 'response') throw new EbayTokenUnavailableError(result.code);
    const body = parseJson(result.text);
    if (result.status === 200 && body !== null) return body;
    // `invalid_grant`: the refresh token (or code) is revoked or expired; `invalid_client`: the
    // keys are wrong. Neither gets better by trying again.
    if (result.status === 400 || result.status === 401) {
      throw new EbayReauthRequiredError(
        body?.['error'] === 'invalid_client'
          ? "Listora's eBay application keys were refused."
          : "Listora's access to eBay has expired.",
      );
    }
    throw new EbayTokenUnavailableError(`http_${String(result.status)}`);
  }
}

function accessTokenOf(body: Record<string, unknown>, started: number): AccessToken {
  const token = body['access_token'];
  const expiresIn = body['expires_in'];
  if (typeof token !== 'string' || token === '' || typeof expiresIn !== 'number') {
    throw new EbayTokenUnavailableError('malformed_token_response');
  }
  return { token, expiresAt: started + expiresIn * 1000 };
}

/**
 * The URL a seller opens to grant Listora access (eBay's consent page); eBay then redirects to
 * the RuName's accept URL with `code` (and `state`) in the query.
 */
export function ebayConsentUrl(options: {
  authorizeUrl: string;
  clientId: string;
  ruName: string;
  scopes: readonly string[];
  state: string;
}): string {
  const query = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.ruName,
    response_type: 'code',
    scope: options.scopes.join(' '),
    state: options.state,
  });
  return `${options.authorizeUrl}?${query.toString()}`;
}

/**
 * The seller behind a connection, as the eBay adapter needs it: a user access token and the
 * seller's listing settings. The token vault (T-16) implements it per connection; until then
 * `RefreshTokenSeller` serves one seller, bound to one connection, from a refresh token.
 */
export interface EbaySellerSource {
  /**
   * The seller's current user access token. Throws `EbayReauthRequiredError` when the seller
   * must connect eBay again (or the connection, or a listing without one, has no seller here),
   * and `EbayTokenUnavailableError` when it can't be had right now.
   */
  accessToken(connection: ConnectionRef | null, signal: AbortSignal): Promise<string>;
  /** eBay refused this token (revoked early): forget it, so the next call refreshes. */
  forget(connection: ConnectionRef | null, token: string): void;
  /** How the seller's listings are shipped, paid, and returned. */
  listingSettings(connection: ConnectionRef | null): EbayListingSettings;
}

/**
 * The seller's listing defaults. With business policy ids (Seller Hub > Business policies) the
 * listing uses them; without, it gets the shipping and return terms below.
 */
export interface EbayListingSettings {
  /** Where the item ships from. */
  postalCode: string;
  /** Business days to ship after payment. */
  dispatchTimeMax: number;
  policies: {
    fulfillmentPolicyId: string;
    paymentPolicyId: string;
    returnPolicyId: string;
  } | null;
}

/** The listing settings used when a seller has configured none (development and the fake). */
export const DEFAULT_LISTING_SETTINGS: EbayListingSettings = {
  postalCode: '95125',
  dispatchTimeMax: 3,
  policies: null,
};

export interface RefreshTokenSellerOptions {
  oauth: EbayOAuthClient;
  refreshToken: string;
  /** The one Listora connection this seller acts for; every other connection is refused. */
  connectionId: string;
  /** A subset of the consented scopes to ask for; default: all of them. */
  scopes?: readonly string[];
  settings?: EbayListingSettings;
  /** Tokens are refreshed this long before they expire. Default 5 minutes. */
  refreshMarginMs?: number;
  now?: () => number;
}

/**
 * One seller, from a refresh token in configuration, bound to one Listora connection: the
 * sandbox check and the fake in development, until per-connection tokens arrive (T-16). Any
 * other connection, and a listing with no connection, must connect eBay: the seller's account
 * never acts for them.
 */
export class RefreshTokenSeller implements EbaySellerSource {
  readonly #options: RefreshTokenSellerOptions;
  readonly #tokens: TokenCache;

  constructor(options: RefreshTokenSellerOptions) {
    this.#options = options;
    this.#tokens = new TokenCache(
      (signal) =>
        options.oauth.refreshUserToken(options.refreshToken, options.scopes ?? [], signal),
      options.refreshMarginMs ?? 5 * 60_000,
      options.now ?? Date.now,
    );
  }

  accessToken(connection: ConnectionRef | null, signal: AbortSignal): Promise<string> {
    if (connection?.id !== this.#options.connectionId) {
      return Promise.reject(new EbayReauthRequiredError('Connect eBay to list there.'));
    }
    return this.#tokens.get(signal);
  }

  forget(connection: ConnectionRef | null, token: string): void {
    if (connection?.id === this.#options.connectionId) this.#tokens.forget(token);
  }

  listingSettings(): EbayListingSettings {
    return this.#options.settings ?? DEFAULT_LISTING_SETTINGS;
  }
}

/** The application token, cached and refreshed single-flight like a seller's. */
export class ApplicationToken {
  readonly #tokens: TokenCache;

  constructor(oauth: EbayOAuthClient, now: () => number = Date.now) {
    this.#tokens = new TokenCache(
      (signal) => oauth.applicationToken([EBAY_APPLICATION_SCOPE], signal),
      5 * 60_000,
      now,
    );
  }

  get(signal: AbortSignal): Promise<string> {
    return this.#tokens.get(signal);
  }

  forget(token: string): void {
    this.#tokens.forget(token);
  }
}

/** An access token, cached until `marginMs` before it expires and refreshed single-flight. */
class TokenCache {
  readonly #refresh: (signal: AbortSignal) => Promise<AccessToken>;
  readonly #marginMs: number;
  readonly #now: () => number;
  #cached: AccessToken | undefined;
  #refreshing: Promise<AccessToken> | undefined;

  constructor(
    refresh: (signal: AbortSignal) => Promise<AccessToken>,
    marginMs: number,
    now: () => number,
  ) {
    this.#refresh = refresh;
    this.#marginMs = marginMs;
    this.#now = now;
  }

  async get(signal: AbortSignal): Promise<string> {
    const cached = this.#cached;
    if (cached !== undefined && cached.expiresAt - this.#marginMs > this.#now())
      return cached.token;
    // No caller's signal: the request's deadline is the OAuth client's own timeout.
    this.#refreshing ??= this.#refresh(new AbortController().signal)
      .then((token) => {
        this.#cached = token;
        return token;
      })
      .finally(() => {
        this.#refreshing = undefined;
      });
    return (await untilAborted(this.#refreshing, signal)).token;
  }

  forget(token: string): void {
    if (this.#cached?.token === token) this.#cached = undefined;
  }
}

/** `shared`, unless `signal` aborts first: then this caller alone stops waiting. */
function untilAborted<T>(shared: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new EbayTokenUnavailableError('aborted'));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(new EbayTokenUnavailableError('aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    void shared.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
