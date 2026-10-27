import { ApiError } from '../errors.ts';

/** Wrong invite codes allowed in a window, across every caller of this API process. */
export const MAX_FAILED_REDEMPTIONS = 30;
export const FAILED_REDEMPTION_WINDOW_MS = 15 * 60_000;

/**
 * Limits guessing at `redeemInvite`, which needs no sign-in. A code has 80 random bits, so
 * guessing one is hopeless anyway; the limit keeps a script from hammering the database. It
 * counts only wrong codes, in memory (an API restart resets it), and past the limit refuses
 * every redemption with `429 rate_limited` until the oldest failure leaves the window.
 */
export class RedemptionLimiter {
  readonly #now: () => number;
  readonly #failures: number[] = [];

  constructor(now: () => number) {
    this.#now = now;
  }

  /** Throws `429 rate_limited` while too many wrong codes were tried. */
  check(): void {
    const now = this.#now();
    while (
      this.#failures.length > 0 &&
      (this.#failures[0] ?? 0) <= now - FAILED_REDEMPTION_WINDOW_MS
    ) {
      this.#failures.shift();
    }
    if (this.#failures.length < MAX_FAILED_REDEMPTIONS) return;
    const oldest = this.#failures[0] ?? now;
    throw new ApiError('rate_limited', 'Too many wrong invite codes. Try again later.', {
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((oldest + FAILED_REDEMPTION_WINDOW_MS - now) / 1000),
      ),
    });
  }

  failed(): void {
    this.#failures.push(this.#now());
  }
}
