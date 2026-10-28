import type { FastifyRequest } from 'fastify';

import { ApiError } from '../errors.ts';

/** Wrong invite codes allowed from one source address in a window. */
export const MAX_FAILED_REDEMPTIONS = 30;
export const FAILED_REDEMPTION_WINDOW_MS = 15 * 60_000;
/** Source addresses remembered at once; past it, the oldest are forgotten first. */
export const MAX_LIMITED_SOURCES = 10_000;

/**
 * Limits guessing at `redeemInvite`, which needs no sign-in. A code has 80 random bits, so
 * guessing one is hopeless anyway; the limit keeps a script from hammering the database. It
 * counts only wrong codes, per source address and in memory (an API restart resets it): past the
 * limit, that source's next wrong code is answered `429 rate_limited` until its oldest failure
 * leaves the window. A right code is never refused, so nobody can lock others out of signing
 * up by sending wrong codes (the route looks the code up before it asks the limiter).
 */
export class RedemptionLimiter {
  readonly #now: () => number;
  /** Each source's failure times, oldest first; the map is in order of each source's first. */
  readonly #failures = new Map<string, number[]>();

  constructor(now: () => number) {
    this.#now = now;
  }

  /**
   * Records a wrong code from `source`, then throws `429 rate_limited` when that source tried
   * too many; returns otherwise, and the caller answers the wrong code as such.
   */
  failed(source: string): void {
    const now = this.#now();
    const times = (this.#failures.get(source) ?? []).filter(
      (time) => time > now - FAILED_REDEMPTION_WINDOW_MS,
    );
    times.push(now);
    this.#failures.delete(source);
    this.#failures.set(source, times);
    this.#forgetOldest();
    if (times.length <= MAX_FAILED_REDEMPTIONS) return;
    // The next try counts too: it passes once enough failures left the window to make room.
    const oldest = times[times.length - MAX_FAILED_REDEMPTIONS] ?? now;
    throw new ApiError('rate_limited', 'Too many wrong invite codes. Try again later.', {
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((oldest + FAILED_REDEMPTION_WINDOW_MS - now) / 1000),
      ),
    });
  }

  #forgetOldest(): void {
    for (const source of this.#failures.keys()) {
      if (this.#failures.size <= MAX_LIMITED_SOURCES) return;
      this.#failures.delete(source);
    }
  }
}

/**
 * The address a request came from: the one the nearest proxy added (the last
 * `X-Forwarded-For` entry, or the last `for=` of `Forwarded`: the load balancer or API Gateway
 * in front of the API), since earlier entries are whatever the client sent; without a proxy,
 * the connection's own.
 */
export function sourceAddress(request: FastifyRequest): string {
  const forwardedFor = lastHeader(request, 'x-forwarded-for')?.split(',').at(-1)?.trim();
  if (forwardedFor !== undefined && forwardedFor !== '') return forwardedFor;
  const forwarded = lastHeader(request, 'forwarded')
    ?.split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => part.toLowerCase().startsWith('for='))
    .at(-1)
    ?.slice('for='.length)
    .replace(/^"|"$/g, '');
  if (forwarded !== undefined && forwarded !== '') return forwarded;
  return request.ip;
}

function lastHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.at(-1) : value;
}
