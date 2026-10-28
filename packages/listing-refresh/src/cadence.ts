/**
 * How often a live listing is refreshed, and when its next refresh is (docs/features/
 * listing-refresh.md). Pure: the settings and the listing's history come in, times go out, so
 * every rule is tested without a database or a clock.
 *
 * A listing is due once it has gone its interval without selling since it was last fresh: when
 * it went live, its last confirmed change (a create, revise, price, or relist), or its last
 * refresh, whatever came of that refresh (one that failed waits a whole interval too, so a
 * marketplace that refuses refreshes is not asked again and again). No refresh starts in the
 * seller's quiet window.
 */
import type { RefreshCadence } from '@listora/db';

/** An account with no setting refreshes every 72 hours, with no quiet window. */
export const DEFAULT_REFRESH_CADENCE: RefreshCadence = 'every_72_hours';

/** The hours between refreshes of each named cadence. */
export const CADENCE_HOURS = {
  every_72_hours: 72,
  daily: 24,
  every_few_days: 120,
  weekly: 168,
} as const satisfies Record<Exclude<RefreshCadence, 'off' | 'custom'>, number>;

/** A custom cadence's bounds, in hours (the database's too). */
export const CUSTOM_HOURS = { min: 12, max: 720 } as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MINUTES = 24 * 60;

export interface Cadence {
  cadence: RefreshCadence;
  /** Only with `custom`. */
  customHours: number | null;
}

/**
 * The seller's quiet window: no refresh starts from `start` up to `end`, minutes after midnight
 * in `timeZone`; it runs past midnight when `end` comes before `start` (22:00 to 07:00).
 */
export interface QuietWindow {
  start: number;
  end: number;
  timeZone: string;
}

/** The hours between refreshes; `null` when refreshing is off. */
export function intervalHours(cadence: Cadence): number | null {
  switch (cadence.cadence) {
    case 'off':
      return null;
    case 'custom':
      return cadence.customHours;
    case 'every_72_hours':
    case 'daily':
    case 'every_few_days':
    case 'weekly':
      return CADENCE_HOURS[cadence.cadence];
  }
}

/** The item's own cadence when it has one, else the account's. */
export function effectiveCadence(item: Cadence | null, account: Cadence): Cadence {
  return item ?? account;
}

/** Minutes after midnight at `at` in `timeZone`. */
export function localMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: 'hour' | 'minute'): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value ?? '0');
  return part('hour') * 60 + part('minute');
}

export function inQuietWindow(at: Date, window: QuietWindow | null): boolean {
  if (window === null) return false;
  const minutes = localMinutes(at, window.timeZone);
  return window.start < window.end
    ? minutes >= window.start && minutes < window.end
    : minutes >= window.start || minutes < window.end;
}

/** `at`, or the end of the quiet window when `at` falls inside it (to the minute). */
export function outsideQuietWindow(at: Date, window: QuietWindow | null): Date {
  if (window === null || !inQuietWindow(at, window)) return at;
  const minutes = localMinutes(at, window.timeZone);
  const untilEnd = (window.end - minutes + DAY_MINUTES) % DAY_MINUTES;
  const start = Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS;
  return new Date(start + untilEnd * MINUTE_MS);
}

/** When the listing is due: `hours` after it was last fresh. */
export function dueAt(freshAt: Date, hours: number): Date {
  return new Date(freshAt.getTime() + hours * HOUR_MS);
}

/**
 * When the next refresh starts, as the listing shows it: when it is due, or now for one already
 * due (it waits its turn within the run limits), moved out of the quiet window.
 */
export function nextRefreshAt(
  freshAt: Date,
  hours: number,
  window: QuietWindow | null,
  now: Date,
): Date {
  const due = dueAt(freshAt, hours);
  return outsideQuietWindow(due < now ? now : due, window);
}

/** `HH:MM` to minutes after midnight; `null` for anything else. */
export function parseClock(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (match === null) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Minutes after midnight as `HH:MM`. */
export function formatClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
