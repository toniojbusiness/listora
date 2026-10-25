/**
 * Trading API daily-call budgeting (plan red flag RF6). eBay gives an application 5,000 Trading
 * calls a day by default, shared by every seller and every Listora process, and refuses calls
 * past the limit until its time window resets. Running out mid-day would stall delists, the
 * one thing that must not wait, so the budget keeps a reserve that only urgent calls (ends,
 * mark-sold, and every read-back, which confirm delists) may use.
 *
 * Every process counts its own calls, and re-reads the application's real usage from eBay's
 * Developer Analytics API (`getRateLimits`, which covers the legacy Trading API) at most every
 * `syncIntervalMs`, and sooner once the reserve is reached, so several workers sharing one
 * quota stay close to eBay's own count. When eBay says the limit is reached (error 518), no
 * call is admitted until the reset. Refused calls are retried after the reset, never dropped.
 */

/** `urgent` may use the reserve; `normal` stops short of it. */
export type CallPriority = 'urgent' | 'normal';

export type BudgetDecision = { ok: true } | { ok: false; retryAfterMs: number };

export interface TradingCallBudget {
  /** Takes one call from the budget, or says how long to wait for the next window. */
  take(priority: CallPriority, signal: AbortSignal): Promise<BudgetDecision>;
  /**
   * eBay refused a call for the daily limit: nothing more is admitted until the reset. Returns
   * how long that is, in milliseconds.
   */
  exhausted(): number;
}

/** The application's Trading API usage as eBay reports it. */
export interface TradingUsage {
  limit: number;
  remaining: number;
  /** When the window resets (epoch milliseconds). */
  resetAt: number;
  /** The window's length in milliseconds. */
  windowMs: number;
}

/** Where the real usage comes from (eBay's `getRateLimits`); it may fail. */
export interface TradingUsageSource {
  read(signal: AbortSignal): Promise<TradingUsage>;
}

export interface DailyCallBudgetOptions {
  /** The application's daily Trading call limit, until eBay reports it. Default 5,000. */
  dailyLimit?: number;
  /** The share of the limit kept for urgent calls. Default 0.1. */
  reserveRatio?: number;
  /** Where real usage is read from; without one the budget counts locally only. */
  usage?: TradingUsageSource;
  /** How often to re-read the real usage. Default 10 minutes. */
  syncIntervalMs?: number;
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** eBay's default daily Trading API call limit per application (plan section 2). */
export const DEFAULT_TRADING_DAILY_LIMIT = 5_000;
/** The soonest a budget re-reads eBay's usage after a read, even when it is short of calls. */
const MIN_SYNC_GAP_MS = 60_000;

export class DailyCallBudget implements TradingCallBudget {
  readonly #reserveRatio: number;
  readonly #usage: TradingUsageSource | undefined;
  readonly #syncIntervalMs: number;
  readonly #now: () => number;
  #limit: number;
  #remaining: number;
  #resetAt: number;
  #windowMs = DAY_MS;
  #lastSyncAt = Number.NEGATIVE_INFINITY;
  #sync: Promise<void> | undefined;

  constructor(options: DailyCallBudgetOptions = {}) {
    this.#reserveRatio = options.reserveRatio ?? 0.1;
    this.#usage = options.usage;
    this.#syncIntervalMs = options.syncIntervalMs ?? 10 * 60_000;
    this.#now = options.now ?? Date.now;
    this.#limit = options.dailyLimit ?? DEFAULT_TRADING_DAILY_LIMIT;
    this.#remaining = this.#limit;
    // Until eBay reports its window, count a rolling day from the first call.
    this.#resetAt = this.#now() + DAY_MS;
  }

  async take(priority: CallPriority, signal: AbortSignal): Promise<BudgetDecision> {
    this.#roll();
    if (this.#syncDue()) await this.#syncOnce(signal);
    this.#roll();
    const floor = priority === 'urgent' ? 0 : this.#reserve();
    if (this.#remaining > floor) {
      this.#remaining -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterMs: Math.max(1_000, this.#resetAt - this.#now()) };
  }

  exhausted(): number {
    this.#roll();
    this.#remaining = 0;
    return Math.max(1_000, this.#resetAt - this.#now());
  }

  /** Calls left in this window, as this process knows it (for tests and logs). */
  get remaining(): number {
    this.#roll();
    return this.#remaining;
  }

  #reserve(): number {
    return Math.max(1, Math.ceil(this.#limit * this.#reserveRatio));
  }

  #roll(): void {
    const now = this.#now();
    if (now < this.#resetAt) return;
    this.#remaining = this.#limit;
    const windows = Math.floor((now - this.#resetAt) / this.#windowMs) + 1;
    this.#resetAt += windows * this.#windowMs;
  }

  #syncDue(): boolean {
    if (this.#usage === undefined) return false;
    const sinceSync = this.#now() - this.#lastSyncAt;
    if (sinceSync >= this.#syncIntervalMs) return true;
    return this.#remaining <= this.#reserve() && sinceSync >= MIN_SYNC_GAP_MS;
  }

  /** One read of eBay's usage at a time; a failed read keeps the local count. */
  #syncOnce(signal: AbortSignal): Promise<void> {
    const usage = this.#usage;
    if (usage === undefined) return Promise.resolve();
    this.#sync ??= (async () => {
      try {
        const reported = await usage.read(signal);
        this.#limit = reported.limit;
        this.#remaining = Math.min(reported.remaining, reported.limit);
        this.#resetAt = reported.resetAt;
        this.#windowMs = reported.windowMs > 0 ? reported.windowMs : DAY_MS;
      } catch {
        // eBay's usage could not be read; the local count stands until the next try.
      } finally {
        this.#lastSyncAt = this.#now();
        this.#sync = undefined;
      }
    })();
    return this.#sync;
  }
}
