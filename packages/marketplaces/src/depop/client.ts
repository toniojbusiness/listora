/**
 * Calls to Depop's Selling API for one connection: the seller's bearer token, the rate limits
 * (rate-limits.ts), and one more try with a fresh token when Depop says the token is invalid.
 * Depop's gateway checks the token before anything else, so a 401 means nothing was done, and
 * that retry is safe for writes too ("If using OAuth, refresh the token using your refresh
 * token", errors guide).
 */
import type { AdapterContext } from '../adapter.ts';
import { requestJson, type HttpResult } from '../http.ts';
import { DepopReauthRequiredError, DepopTokenUnavailableError } from './oauth.ts';
import type { DepopRateGroup, DepopRateLimiter } from './rate-limits.ts';
import type { DepopSellerSource } from './seller.ts';

export interface DepopApiOptions {
  /** `https://partnerapi.depop.com` (or staging's, or the fake's). */
  baseUrl: string;
  seller: DepopSellerSource;
  limiter: DepopRateLimiter;
  timeoutMs: number;
}

export interface DepopCall {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Path and query, for example `/api/v1/products/by-sku/AJ-000184-D1/`. */
  path: string;
  body?: unknown;
  /** The per-seller allowance it uses (rate-limits.ts). */
  group: DepopRateGroup;
}

export type DepopCallResult =
  | Extract<HttpResult, { type: 'response' }>
  | Exclude<HttpResult, { type: 'response' }>
  /** Listora's own rate limit held the request back; nothing was sent. */
  | { type: 'rate_limited'; retryAfterMs: number }
  /** No token: the seller must connect Depop again, or Depop's sign-in is unavailable. */
  | { type: 'token_failed'; error: DepopReauthRequiredError | DepopTokenUnavailableError };

/** One error of Depop's `ErrorResponse` (`{ id, errors: [{ code, message }] }`). */
export interface DepopError {
  code: string;
  message: string;
}

export class DepopApi {
  readonly #options: DepopApiOptions;

  constructor(options: DepopApiOptions) {
    this.#options = { ...options, baseUrl: options.baseUrl.replace(/\/+$/, '') };
  }

  async call(call: DepopCall, ctx: AdapterContext): Promise<DepopCallResult> {
    let refusedToken: string | undefined;
    for (;;) {
      let token: string;
      try {
        token = await this.#options.seller.accessToken(ctx.connection, ctx.signal);
      } catch (error) {
        if (
          error instanceof DepopReauthRequiredError ||
          error instanceof DepopTokenUnavailableError
        ) {
          return { type: 'token_failed', error };
        }
        throw error;
      }
      const seller = ctx.connection?.id ?? 'none';
      const room = await this.#options.limiter.acquire(seller, call.group, ctx.signal);
      if (!room.ok) return { type: 'rate_limited', retryAfterMs: room.retryAfterMs };
      const result = await requestJson({
        method: call.method,
        url: `${this.#options.baseUrl}${call.path}`,
        ...(call.body === undefined ? {} : { body: call.body }),
        headers: { authorization: `Bearer ${token}` },
        signal: ctx.signal,
        timeoutMs: this.#options.timeoutMs,
      });
      if (result.type !== 'response') return result;
      if (result.status === 401 && errorCodes(result.body).includes('unauthorized')) {
        this.#options.seller.forget(ctx.connection, token);
        // Once with a fresh token; a fresh token refused too means the grant is gone.
        if (refusedToken === undefined) {
          refusedToken = token;
          continue;
        }
      }
      return result;
    }
  }
}

/** The errors of a Depop `ErrorResponse`; empty for any other body. */
export function depopErrors(body: unknown): DepopError[] {
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((error: unknown) => {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    return typeof code === 'string'
      ? [{ code, message: typeof message === 'string' ? message : '' }]
      : [];
  });
}

function errorCodes(body: unknown): string[] {
  return depopErrors(body).map((error) => error.code);
}

/** `Retry-After` ("Number of seconds to wait before retrying") in milliseconds. */
export function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Number(value.trim()) * 1000;
}
