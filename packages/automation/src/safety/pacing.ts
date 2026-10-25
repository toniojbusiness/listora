/**
 * Polite pacing: automation never acts faster than a careful person would. Every click, fill,
 * upload, and navigation waits a random delay from the marketplace's `actionDelayMs` first,
 * typing waits between keystrokes, and a seller's next browser session waits `sessionGapMs`
 * after the last one started. This keeps automation from hammering a marketplace or acting in
 * bursts no person could; it is pacing, not disguise: the runner never hides that it is a
 * browser driven by software.
 */
import type { DelayRange, PacingSettings } from '../profiles.ts';

export type PaceKind = 'action' | 'keystroke' | 'session';

export interface PacingOptions {
  /** Uniform in [0, 1); tests fix it. */
  random?: () => number;
  /** Waits `ms`, or rejects when `signal` aborts first; tests replace it. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class Pacing {
  readonly settings: PacingSettings;
  readonly #random: () => number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(settings: PacingSettings, options: PacingOptions = {}) {
    for (const range of [
      settings.actionDelayMs,
      settings.keystrokeDelayMs,
      settings.sessionGapMs,
    ]) {
      checkRange(range);
    }
    this.settings = settings;
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? abortableSleep;
  }

  /** A delay for `kind`, uniform in its range. */
  delayMs(kind: PaceKind): number {
    const [min, max] = this.#range(kind);
    return Math.round(min + (max - min) * this.#random());
  }

  /** Waits a delay for `kind`; rejects when `signal` aborts. */
  async wait(kind: PaceKind, signal: AbortSignal): Promise<void> {
    await this.#sleep(this.delayMs(kind), signal);
  }

  /** Waits whatever is left of `ms`, for example the rest of a session gap. */
  async waitFor(ms: number, signal: AbortSignal): Promise<void> {
    if (ms > 0) await this.#sleep(ms, signal);
  }

  #range(kind: PaceKind): DelayRange {
    switch (kind) {
      case 'action':
        return this.settings.actionDelayMs;
      case 'keystroke':
        return this.settings.keystrokeDelayMs;
      case 'session':
        return this.settings.sessionGapMs;
    }
  }
}

function checkRange([min, max]: DelayRange): void {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
    throw new RangeError('a delay range needs 0 <= min <= max');
  }
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}
