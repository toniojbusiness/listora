/**
 * Connecting a seller's eBay account (`MarketplaceOAuthClient`, `@listora/connections` drives
 * it): eBay's OAuth 2.0 authorization code grant, as eBay documents it ("Authorization" guide,
 * developer.ebay.com, read 2026-10-24):
 *
 * - Consent: the seller opens `authorize?client_id&redirect_uri=<RuName>&response_type=code&
 *   scope&state` and, on "Agree", eBay sends the browser to the RuName's accept URL with `code`
 *   (single use, about five minutes) and the same `state`.
 * - Exchange: `POST token` with HTTP Basic client credentials and the form
 *   `grant_type=authorization_code&code&redirect_uri=<RuName>` returns `access_token`
 *   (`expires_in`, two hours), `refresh_token` (`refresh_token_expires_in`, about 18 months).
 * - Refresh: `grant_type=refresh_token&refresh_token` (no scope: the consented ones) returns a
 *   new access token only;
 *   the refresh token stays the same until it expires or the seller revokes it (a password or
 *   user name change also revokes it). eBay answers `invalid_grant` for a dead refresh token.
 * - Revocation: `POST token/revoke` with `token` and `token_type_hint` answers `200` with an
 *   empty body.
 * - The seller: Commerce Identity `getUser` returns the immutable `userId` and the `username`.
 */
import { assertNever } from '@listora/shared';

import type {
  CodeExchangeResult,
  IdentityResult,
  MarketplaceOAuthClient,
  OAuthCallContext,
  OAuthFailure,
  OAuthTokens,
  TokenRefreshResult,
} from '../oauth.ts';
import { requestJson, requestText, type HttpResult } from '../http.ts';
import type { EbayConfig } from './config.ts';
import { EBAY_USER_SCOPES, ebayConsentUrl } from './oauth.ts';

/** How long one eBay OAuth call may take. */
const CALL_TIMEOUT_MS = 15_000;

export class EbayConnectClient implements MarketplaceOAuthClient {
  readonly marketplace = 'ebay';
  readonly scopes: readonly string[] = EBAY_USER_SCOPES;
  readonly #config: EbayConfig;
  readonly #ruName: string;

  /** Undefined when the configuration has no RuName (sellers then cannot connect). */
  static fromConfig(config: EbayConfig): EbayConnectClient | undefined {
    return config.ruName === undefined ? undefined : new EbayConnectClient(config, config.ruName);
  }

  private constructor(config: EbayConfig, ruName: string) {
    this.#config = config;
    this.#ruName = ruName;
  }

  authorizationUrl(state: string): string {
    return ebayConsentUrl({
      authorizeUrl: this.#config.endpoints.authorize,
      clientId: this.#config.clientId,
      ruName: this.#ruName,
      scopes: this.scopes,
      state,
    });
  }

  async exchangeCode(code: string, ctx: OAuthCallContext): Promise<CodeExchangeResult> {
    const answer = tokenAnswer(
      await this.#token(
        { grant_type: 'authorization_code', code, redirect_uri: this.#ruName },
        ctx,
      ),
    );
    switch (answer.type) {
      case 'grant_refused':
        return {
          type: 'rejected',
          code: 'authorization_code_rejected',
          message: 'eBay did not accept the sign-in. Connect eBay again.',
        };
      case 'failed':
        return { type: 'unavailable', ...answer.failure };
      case 'ok': {
        const { body } = answer;
        if (
          !isNonEmptyString(body.access_token) ||
          !isNonEmptyString(body.refresh_token) ||
          !isPositiveNumber(body.expires_in)
        ) {
          return { type: 'unavailable', ...INVALID_RESPONSE };
        }
        return {
          type: 'granted',
          grant: {
            tokens: { accessToken: body.access_token, refreshToken: body.refresh_token },
            accessExpiresAt: secondsAfter(ctx.now, body.expires_in),
            refreshExpiresAt: isPositiveNumber(body.refresh_token_expires_in)
              ? secondsAfter(ctx.now, body.refresh_token_expires_in)
              : null,
            scopes: [...this.scopes],
          },
        };
      }
      default:
        return assertNever(answer, 'token answer');
    }
  }

  async refresh(refreshToken: string, ctx: OAuthCallContext): Promise<TokenRefreshResult> {
    const answer = tokenAnswer(
      await this.#token({ grant_type: 'refresh_token', refresh_token: refreshToken }, ctx),
    );
    switch (answer.type) {
      case 'grant_refused':
        return {
          type: 'reauth_required',
          code: 'grant_revoked',
          message:
            "eBay no longer accepts Listora's access (it was revoked or expired). Reconnect eBay.",
        };
      case 'failed':
        return { type: 'unavailable', ...answer.failure };
      case 'ok': {
        const { body } = answer;
        if (!isNonEmptyString(body.access_token) || !isPositiveNumber(body.expires_in)) {
          return { type: 'unavailable', ...INVALID_RESPONSE };
        }
        return {
          type: 'refreshed',
          accessToken: body.access_token,
          accessExpiresAt: secondsAfter(ctx.now, body.expires_in),
          ...(isNonEmptyString(body.refresh_token) ? { refreshToken: body.refresh_token } : {}),
          ...(isPositiveNumber(body.refresh_token_expires_in)
            ? { refreshExpiresAt: secondsAfter(ctx.now, body.refresh_token_expires_in) }
            : {}),
        };
      }
      default:
        return assertNever(answer, 'token answer');
    }
  }

  async identify(accessToken: string, ctx: OAuthCallContext): Promise<IdentityResult> {
    const result = await requestJson({
      method: 'GET',
      url: this.#config.endpoints.identity,
      headers: { authorization: `Bearer ${accessToken}` },
      signal: ctx.signal,
      timeoutMs: CALL_TIMEOUT_MS,
    });
    if (result.type !== 'response') return { type: 'unavailable', ...unreachable(result) };
    if (result.status === 401) {
      return {
        type: 'unauthorized',
        code: 'access_token_rejected',
        message: "eBay did not accept Listora's access token.",
      };
    }
    if (result.status !== 200) {
      return { type: 'unavailable', ...httpFailure(result), ...retryAfter(result) };
    }
    const body = (result.body ?? {}) as { userId?: unknown; username?: unknown };
    if (!isNonEmptyString(body.userId)) return { type: 'unavailable', ...INVALID_RESPONSE };
    return {
      type: 'identified',
      externalUserId: body.userId,
      displayName: isNonEmptyString(body.username) ? body.username : null,
    };
  }

  async revoke(tokens: OAuthTokens, ctx: OAuthCallContext): Promise<boolean> {
    const result = await this.#postForm(
      this.#config.endpoints.oauthRevoke,
      { token: tokens.refreshToken, token_type_hint: 'refresh_token' },
      ctx,
    );
    return result.type === 'response' && result.status === 200;
  }

  #token(form: Record<string, string>, ctx: OAuthCallContext): Promise<HttpResult> {
    return this.#postForm(this.#config.endpoints.oauthToken, form, ctx);
  }

  /** A form POST with the app's credentials, its JSON answer parsed (null when not JSON). */
  async #postForm(
    url: string,
    form: Record<string, string>,
    ctx: OAuthCallContext,
  ): Promise<HttpResult> {
    const result = await requestText({
      method: 'POST',
      url,
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        authorization: this.#basicAuth(),
      },
      body: new URLSearchParams(form).toString(),
      signal: ctx.signal,
      timeoutMs: CALL_TIMEOUT_MS,
    });
    if (result.type !== 'response') return result;
    const { text, ...response } = result;
    return { ...response, body: parseJson(text) };
  }

  #basicAuth(): string {
    const credentials = `${this.#config.clientId}:${this.#config.clientSecret}`;
    return `Basic ${Buffer.from(credentials).toString('base64')}`;
  }
}

interface TokenBody {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  refresh_token_expires_in?: unknown;
  error?: unknown;
}

const INVALID_RESPONSE: OAuthFailure = {
  code: 'invalid_response',
  message: 'eBay sent an answer Listora could not read. Try again.',
};

/**
 * What a token request came to. `grant_refused`: eBay refused the code or refresh token itself
 * (`invalid_grant`), which only the seller's consent fixes. `failed`: eBay could not be asked,
 * or refused Listora's own app credentials (`invalid_client`).
 */
function tokenAnswer(
  result: HttpResult,
):
  | { type: 'ok'; body: TokenBody }
  | { type: 'grant_refused' }
  | { type: 'failed'; failure: OAuthFailure & { retryAfterMs?: number } } {
  if (result.type !== 'response') return { type: 'failed', failure: unreachable(result) };
  const body = (
    typeof result.body === 'object' && result.body !== null ? result.body : {}
  ) as TokenBody;
  if (result.status === 200) return { type: 'ok', body };
  if (result.status === 400 && body.error === 'invalid_grant') return { type: 'grant_refused' };
  if (result.status === 401 || body.error === 'invalid_client') {
    return {
      type: 'failed',
      failure: {
        code: 'client_rejected',
        message: "eBay refused Listora's app credentials. Listora has to fix this.",
      },
    };
  }
  return { type: 'failed', failure: { ...httpFailure(result), ...retryAfter(result) } };
}

function httpFailure(result: Extract<HttpResult, { type: 'response' }>): OAuthFailure {
  if (result.status === 429) {
    return {
      code: 'rate_limited',
      message: 'eBay is limiting requests right now. Try again soon.',
    };
  }
  if (result.status >= 500) {
    return { code: 'marketplace_error', message: 'eBay had a problem. Try again soon.' };
  }
  return { code: 'unexpected_response', message: 'eBay sent an unexpected answer. Try again.' };
}

function unreachable(result: Exclude<HttpResult, { type: 'response' }>): OAuthFailure {
  return {
    code: result.code === 'timeout' ? 'timeout' : 'unreachable',
    message: 'Listora could not reach eBay. Try again soon.',
  };
}

/** eBay's `Retry-After` on a 429, in milliseconds. */
function retryAfter(result: HttpResult): { retryAfterMs?: number } {
  if (result.type !== 'response' || result.status !== 429) return {};
  const seconds = Number(result.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? { retryAfterMs: seconds * 1000 } : {};
}

function secondsAfter(now: Date, seconds: number): Date {
  return new Date(now.getTime() + seconds * 1000);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
