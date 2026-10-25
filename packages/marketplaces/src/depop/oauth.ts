/**
 * Depop OAuth 2.0 (https://partnerapi.depop.com/api-docs/concepts/authentication/): the
 * authorization code flow with PKCE (S256) by which a seller connects Depop, and the refresh
 * token grant. Depop's tokens differ from eBay's in two ways that matter:
 *
 * - **Refresh tokens rotate.** "You receive a new Refresh Token with every successful refresh
 *   request. The previous Access Token and Refresh Token are immediately invalidated", so the
 *   newest refresh token must never be lost (tokens.ts keeps it safe).
 * - **The grant lasts a year from consent.** "The new Refresh Token inherits the original
 *   expiration date of the grant (1 year from initial user consent)"; token responses don't say
 *   when that is, so Listora counts it from the code exchange.
 *
 * Tokens never reach logs, excerpts, or error messages.
 */
import { createHash, randomBytes } from 'node:crypto';

import { requestText } from '../http.ts';

/**
 * The scopes Listora asks a seller to grant: listings (`products_*`), sales (`orders_read`), and
 * the shop's addresses for Depop Shipping and the health check (`shop_read`).
 */
export const DEPOP_SCOPES = [
  'products_read',
  'products_write',
  'orders_read',
  'shop_read',
] as const;

/** How long a Depop grant lasts from the seller's consent: one year. */
export const DEPOP_GRANT_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

/** The seller must connect Depop again: the grant was revoked, expired, or never existed. */
export class DepopReauthRequiredError extends Error {
  constructor(message = "Listora's access to Depop has expired.") {
    super(message);
    this.name = 'DepopReauthRequiredError';
  }
}

/** Depop's token endpoint could not answer now; trying again later may work. */
export class DepopTokenUnavailableError extends Error {
  /** Why: a transport code (`timeout`, `ECONNREFUSED`), `http_<status>`, or `aborted`. */
  readonly code: string;

  constructor(code: string) {
    super(`Depop's sign-in service is unavailable (${code}).`);
    this.name = 'DepopTokenUnavailableError';
    this.code = code;
  }
}

/** A seller's tokens for one Depop grant. Times are epoch milliseconds. */
export interface DepopTokens {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  /** When the grant ends (a year after consent); no refresh outlives it. */
  grantExpiresAt: number;
}

/** A PKCE pair: the verifier stays with Listora, the challenge goes in the consent URL. */
export interface PkcePair {
  verifier: string;
  challenge: string;
}

/**
 * A new PKCE pair: a 43-character verifier from `[A-Za-z0-9._~-]` (base64url of 32 random
 * bytes) and its S256 challenge, "the SHA-256 hash of the code_verifier, then Base64
 * URL-encode the hash".
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export interface DepopOAuthClientOptions {
  /** `https://partnerapi.depop.com/api/v1/oauth2/access-token/` (or staging's, or the fake's). */
  tokenUrl: string;
  /** Depop's consent page: `https://www.depop.com/settings/oauth/apps/` (or the fake's). */
  authorizeUrl: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
  now?: () => number;
}

export class DepopOAuthClient {
  readonly #options: DepopOAuthClientOptions;
  readonly #now: () => number;

  constructor(options: DepopOAuthClientOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** How long one token endpoint request may take. */
  get timeoutMs(): number {
    return this.#options.timeoutMs ?? 10_000;
  }

  /**
   * The URL a seller opens to grant Listora access. `state` is a fresh unguessable value the
   * caller keeps and compares with the callback's (CSRF protection), and `codeChallenge` the
   * challenge of a PKCE pair whose verifier the caller keeps for the code exchange. Scopes are
   * "Joined with +".
   */
  authorizationUrl(options: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
    scopes?: readonly string[];
  }): string {
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: this.#options.clientId,
      redirect_uri: options.redirectUri,
      state: options.state,
      scope: (options.scopes ?? DEPOP_SCOPES).join('+'),
      code_challenge: options.codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${this.#options.authorizeUrl}?${query.toString()}`;
  }

  /**
   * The seller's tokens for an authorization code from the consent callback ("A temporary
   * (10-minute), single-use authorization code"), with the PKCE verifier its challenge came
   * from. The grant's year starts now.
   */
  async exchangeAuthorizationCode(
    options: { code: string; redirectUri: string; codeVerifier: string },
    signal: AbortSignal,
  ): Promise<DepopTokens> {
    const started = this.#now();
    const body = await this.#post(
      {
        grant_type: 'authorization_code',
        code: options.code,
        redirect_uri: options.redirectUri,
        code_verifier: options.codeVerifier,
      },
      signal,
    );
    return tokensOf(body, started, started + DEPOP_GRANT_LIFETIME_MS);
  }

  /**
   * New tokens for a refresh token. Depop invalidates `tokens.refreshToken` and the access token
   * the moment it answers, so the caller must keep the result before anything else.
   */
  async refresh(tokens: DepopTokens, signal: AbortSignal): Promise<DepopTokens> {
    if (tokens.grantExpiresAt <= this.#now()) throw new DepopReauthRequiredError();
    const started = this.#now();
    const body = await this.#post(
      { grant_type: 'refresh_token', refresh_token: tokens.refreshToken },
      signal,
    );
    return tokensOf(body, started, tokens.grantExpiresAt);
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
      },
      body: new URLSearchParams({
        ...fields,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal,
      timeoutMs: this.timeoutMs,
    });
    if (result.type !== 'response') throw new DepopTokenUnavailableError(result.code);
    const body = parseJson(result.text);
    if (result.status === 200 && body !== null) return body;
    // `invalid_grant`: the code or refresh token is invalid, expired, revoked, or used; 401: the
    // application's keys were refused. Neither gets better by trying again.
    if (result.status === 400 || result.status === 401) {
      throw new DepopReauthRequiredError(
        result.status === 401 && body?.['error'] !== 'invalid_refresh_token'
          ? "Listora's Depop application keys were refused."
          : "Listora's access to Depop has expired.",
      );
    }
    throw new DepopTokenUnavailableError(`http_${String(result.status)}`);
  }
}

function tokensOf(
  body: Record<string, unknown>,
  started: number,
  grantExpiresAt: number,
): DepopTokens {
  const accessToken = body['access_token'];
  const refreshToken = body['refresh_token'];
  const expiresIn = body['expires_in'];
  if (
    typeof accessToken !== 'string' ||
    accessToken === '' ||
    typeof refreshToken !== 'string' ||
    refreshToken === '' ||
    typeof expiresIn !== 'number'
  ) {
    throw new DepopTokenUnavailableError('malformed_token_response');
  }
  return {
    accessToken,
    accessExpiresAt: started + expiresIn * 1000,
    refreshToken,
    grantExpiresAt,
  };
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
