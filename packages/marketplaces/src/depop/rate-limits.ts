/**
 * Depop's rate limits, kept on Listora's side so a burst (a bulk relist, many sellers at once)
 * slows down instead of failing (https://partnerapi.depop.com/api-docs/concepts/rate-limits/,
 * checked 2026-10-24):
 *
 * - per shop or seller: "Create or fully update a listing" (POST and PUT products) 200 requests
 *   per 10 seconds, and "Everything else" 6,000 requests per minute;
 * - per application, for cross-listers: 30,000 requests per minute "for every seller and every
 *   endpoint combined". "Staying within each seller's limits is not enough."
 *
 * Each allowance is a sliding window: a request goes when fewer than the limit were sent in the
 * window before it, so no window, however it is aligned, ever holds more. The window is kept a
 * little longer than Depop's (5%, at least 50 ms and at most a second), since Depop counts a
 * request when it arrives and Listora when it sends it. A request waits for
 * room up to `maxWaitMs`; past that it is not sent, and the adapter reports a transient
 * `rate_limited` outcome that retries later. A 429 from Depop is transient too, and the engine
 * waits at least its `Retry-After` before trying that operation again.
 *
 * The windows live in this process. Several workers share the application allowance, so each
 * runs with its share of it (`DEPOP_APP_REQUESTS_PER_MINUTE`).
 */

/** Which per-seller allowance a request uses. */
export type DepopRateGroup = 'listing_write' | 'other';

export interface RateWindow {
  requests: number;
  windowMs: number;
}

export const DEPOP_RATE_LIMITS = {
  listingWrite: { requests: 200, windowMs: 10_000 },
  other: { requests: 6_000, windowMs: 60_000 },
  application: { requests: 30_000, windowMs: 60_000 },
} as const satisfies Record<string, RateWindow>;

export type RateDecision = { ok: true } | { ok: false; retryAfterMs: number };

export interface DepopRateLimiterOptions {
  /** This process's share of the application allowance, per minute. Default 30,000. */
  applicationPerMinute?: number;
  /** The per-seller allowances; Depop's by default. */
  seller?: { listingWrite: RateWindow; other: RateWindow };
  /** The longest a request waits for room before it is reported rate limited. Default 2 s. */
  maxWaitMs?: number;
  now?: () => number;
}

/** A sliding window of the times requests were sent. */
class SlidingWindow {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #sent: number[] = [];

  constructor(window: RateWindow) {
    this.#limit = window.requests;
    this.#windowMs = window.windowMs + Math.min(1_000, Math.max(50, window.windowMs * 0.05));
  }

  /** How long until a request may go; 0 when it may go now. */
  waitMs(now: number): number {
    while (this.#sent.length > 0 && (this.#sent[0] ?? 0) <= now - this.#windowMs) {
      this.#sent.shift();
    }
    if (this.#sent.length < this.#limit) return 0;
    const oldest = this.#sent[this.#sent.length - this.#limit] ?? now;
    return Math.max(0, oldest + this.#windowMs - now);
  }

  record(now: number): void {
    this.#sent.push(now);
  }
}

export class DepopRateLimiter {
  readonly #application: SlidingWindow;
  readonly #sellerLimits: { listingWrite: RateWindow; other: RateWindow };
  readonly #sellers = new Map<string, SlidingWindow>();
  readonly #maxWaitMs: number;
  readonly #now: () => number;

  constructor(options: DepopRateLimiterOptions = {}) {
    this.#application = new SlidingWindow({
      requests: options.applicationPerMinute ?? DEPOP_RATE_LIMITS.application.requests,
      windowMs: DEPOP_RATE_LIMITS.application.windowMs,
    });
    this.#sellerLimits = options.seller ?? {
      listingWrite: DEPOP_RATE_LIMITS.listingWrite,
      other: DEPOP_RATE_LIMITS.other,
    };
    this.#maxWaitMs = options.maxWaitMs ?? 2_000;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Takes room for one request of `seller` (a connection id) in its allowance for `group` and
   * in the application's, waiting for it up to `maxWaitMs`. Takes nothing when it can't.
   */
  async acquire(seller: string, group: DepopRateGroup, signal: AbortSignal): Promise<RateDecision> {
    const windows = [this.#seller(seller, group), this.#application];
    for (;;) {
      const now = this.#now();
      const waitMs = Math.max(...windows.map((window) => window.waitMs(now)));
      if (waitMs === 0) {
        for (const window of windows) window.record(now);
        return { ok: true };
      }
      if (waitMs > this.#maxWaitMs || signal.aborted) return { ok: false, retryAfterMs: waitMs };
      await sleep(waitMs, signal);
    }
  }

  #seller(seller: string, group: DepopRateGroup): SlidingWindow {
    const key = `${group}:${seller}`;
    let window = this.#sellers.get(key);
    if (window === undefined) {
      window = new SlidingWindow(
        group === 'listing_write' ? this.#sellerLimits.listingWrite : this.#sellerLimits.other,
      );
      this.#sellers.set(key, window);
    }
    return window;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
