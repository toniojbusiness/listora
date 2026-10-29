/**
 * Request limits per source address and per account (audit M4, docs/features/security.md), so
 * one noisy caller, signed in or not, cannot use up the API for everyone else. The environment's
 * own throttle in front of the API (infra) stays as its cost ceiling.
 *
 * - Every request but the health checks and the local storage driver's signed files counts
 *   against its source address (`sourceAddress`: the address the nearest proxy saw).
 * - A request no sign-in protects (redeeming an invite, the OAuth callback, the dev sign-in, an
 *   unknown path) also counts against a much smaller budget per address. The eBay webhook does
 *   not: eBay sends every seller's notifications from its own few addresses.
 * - A signed-in request also counts against its account, after the tenancy guard.
 *
 * Each limit is a number of requests per minute, refilled evenly, so a minute's worth may come at
 * once and then one every `60 / limit` seconds. Past it, the request is answered
 * `429 rate_limited` with `Retry-After` before any work. The counts are in memory, per API task
 * (a restart forgets them), and hold at most `MAX_LIMITED_KEYS` keys each, forgetting the least
 * recent first.
 */
import { LOCAL_STORAGE_ROUTE_PREFIX } from '@listora/storage';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ApiError } from './errors.ts';
import { sourceAddress } from './invites/limiter.ts';
import { EBAY_WEBHOOK_PATH } from './webhooks/ebay.ts';

/** Requests per minute (`API_RATE_LIMIT_*`, `.env.example`). */
export interface RateLimits {
  /** Every request from one source address. */
  perAddress: number;
  /** Requests from one source address that no sign-in protects. */
  publicPerAddress: number;
  /** Signed-in requests of one account. */
  perAccount: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  perAddress: 1200,
  publicPerAddress: 60,
  perAccount: 600,
};

/** Keys one limiter remembers at once; past it, the least recent are forgotten first. */
export const MAX_LIMITED_KEYS = 10_000;

const MINUTE_MS = 60_000;

/** Which limits a route counts against, besides its address's (route `config.rateLimit`). */
export type RouteLimit = 'account' | 'public' | 'address' | 'none';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Set by `contractRoute` (`account`); every other route is classed by its path. */
    rateLimit?: RouteLimit;
  }
}

interface Bucket {
  tokens: number;
  at: number;
  /** Refused since it last had room, so one refusal is logged and a flood is not. */
  refusing: boolean;
}

/** A token bucket per key: `perMinute` tokens, refilled evenly over a minute. */
export class RequestLimiter {
  readonly #perMinute: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(perMinute: number, now: () => number) {
    this.#perMinute = perMinute;
    this.#now = now;
  }

  /**
   * Takes one request for `key`: `undefined` when it may go on, else the whole seconds until it
   * could (`first` says whether this is the first refusal since it last had room).
   */
  take(key: string): { retryAfterSeconds: number; first: boolean } | undefined {
    const now = this.#now();
    const rate = this.#perMinute / MINUTE_MS;
    const bucket = this.#buckets.get(key) ?? { tokens: this.#perMinute, at: now, refusing: false };
    bucket.tokens = Math.min(this.#perMinute, bucket.tokens + Math.max(0, now - bucket.at) * rate);
    bucket.at = now;
    // The most recent key goes last, so the first are the least recently seen.
    this.#buckets.delete(key);
    this.#buckets.set(key, bucket);
    this.#forgetOldest();
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      bucket.refusing = false;
      return undefined;
    }
    const first = !bucket.refusing;
    bucket.refusing = true;
    return { retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / rate / 1000)), first };
  }

  #forgetOldest(): void {
    for (const key of this.#buckets.keys()) {
      if (this.#buckets.size <= MAX_LIMITED_KEYS) return;
      this.#buckets.delete(key);
    }
  }
}

export interface ApiRateLimiters {
  address: RequestLimiter;
  publicAddress: RequestLimiter;
  account: RequestLimiter;
}

export function createRateLimiters(limits: RateLimits, now: () => number): ApiRateLimiters {
  return {
    address: new RequestLimiter(limits.perAddress, now),
    publicAddress: new RequestLimiter(limits.publicPerAddress, now),
    account: new RequestLimiter(limits.perAccount, now),
  };
}

/** Counts every request against its source address (and the public budget) before any work. */
export function registerRateLimits(app: FastifyInstance, limiters: ApiRateLimiters): void {
  app.addHook('onRequest', (request, _reply, done) => {
    const limit = routeLimit(request);
    try {
      if (limit !== 'none') {
        const address = sourceAddress(request);
        take(request, limiters.address, address, 'address');
        if (limit === 'public') take(request, limiters.publicAddress, address, 'public');
      }
    } catch (error) {
      done(error as Error);
      return;
    }
    done();
  });
}

/** Counts a signed-in request against its account; `contractRoute` calls it after the guard. */
export function limitAccount(
  request: FastifyRequest,
  limiters: ApiRateLimiters | undefined,
  accountId: string,
): void {
  if (limiters !== undefined) take(request, limiters.account, accountId, 'account');
}

function routeLimit(request: FastifyRequest): RouteLimit {
  const configured = request.routeOptions.config.rateLimit;
  if (configured !== undefined) return configured;
  const url = request.routeOptions.url ?? '';
  if (url.startsWith('/health/') || url.startsWith(LOCAL_STORAGE_ROUTE_PREFIX)) return 'none';
  if (url === EBAY_WEBHOOK_PATH) return 'address';
  return 'public';
}

function take(
  request: FastifyRequest,
  limiter: RequestLimiter,
  key: string,
  kind: 'address' | 'public' | 'account',
): void {
  const refused = limiter.take(key);
  if (refused === undefined) return;
  // Once per run of refusals, without the address (personal data): the kind is enough to tune.
  if (refused.first) request.log.warn({ rateLimit: kind }, 'request rate limited');
  throw new ApiError('rate_limited', 'Too many requests. Try again in a moment.', {
    retryAfterSeconds: refused.retryAfterSeconds,
  });
}
