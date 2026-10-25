/**
 * How long until a seller's next sale check on a marketplace (decision D1): about every 12
 * hours by default, adapted to the seller's own sales history there, within the configured
 * minimum and maximum.
 *
 * The rule: every check should cover about as many expected sales as an average default
 * interval does. From the seller's sales over the last 12 weeks on that marketplace, Listora
 * estimates their sales rate for each hour of the week (UTC), smoothed over neighboring hours
 * and pulled toward their average while the history is thin (few sales, or under four weeks). A recent run of sales above that
 * average ("hot" items) raises the rate, and a quiet spell lowers it. The next check is due once
 * the expected sales since now reach the default interval's share: sooner across the hours and
 * days their sales usually happen and while items are hot, later when things are idle. With
 * fewer than five sales there is nothing to adapt to, and the default applies.
 */
import type { SaleCheckSettings } from '../settings.ts';

const HOUR_MS = 3_600_000;
const WEEK_HOURS = 7 * 24;
/** How far back sales count. */
export const SALE_HISTORY_DAYS = 84;
/** Fewer sales than this say nothing about when the seller's sales happen. */
export const MIN_SALES_TO_ADAPT = 5;
/** The window of recent sales that makes items "hot". */
const RECENT_HOURS = 72;
/** How strongly a thin history is pulled toward the seller's average rate. */
const PRIOR_SALES = 20;
/** Weeks of history before the hour-of-week pattern is fully trusted (it repeats weekly). */
const PATTERN_WEEKS = 4;
/** How far recent activity can move the rate, either way. */
const HEAT_RANGE = [0.5, 3] as const;

export interface SaleCheckDelay {
  delayMs: number;
  /** `history` when the seller's sales shaped it, `default` otherwise. */
  basis: 'default' | 'history';
}

/** The delay until the next sale check, from the seller's sale times on this marketplace. */
export function nextSaleCheckDelay(
  now: Date,
  saleTimes: readonly Date[],
  settings: SaleCheckSettings,
): SaleCheckDelay {
  const nowMs = now.getTime();
  const lookbackStart = nowMs - SALE_HISTORY_DAYS * 24 * HOUR_MS;
  const sales = saleTimes
    .map((time) => time.getTime())
    .filter((time) => time >= lookbackStart && time <= nowMs);
  if (sales.length < MIN_SALES_TO_ADAPT) {
    return { delayMs: settings.defaultIntervalMs, basis: 'default' };
  }

  // The seller's average rate over the history they have (at least a week of it).
  const earliest = Math.min(...sales);
  const spanHours = Math.max(WEEK_HOURS, (nowMs - earliest) / HOUR_MS);
  const average = sales.length / spanHours;

  // Their rate per hour of the week, smoothed and pulled toward the average.
  const counts = new Array<number>(WEEK_HOURS).fill(0);
  for (const time of sales) counts[hourOfWeek(time)] = (counts[hourOfWeek(time)] ?? 0) + 1;
  const weeks = spanHours / WEEK_HOURS;
  const weeksObserved = (nowMs - earliest) / (WEEK_HOURS * HOUR_MS);
  const weight =
    Math.min(1, weeksObserved / PATTERN_WEEKS) * (sales.length / (sales.length + PRIOR_SALES));
  const rate = counts.map((_, hour) => {
    const smoothed =
      ((counts[(hour + WEEK_HOURS - 1) % WEEK_HOURS] ?? 0) +
        2 * (counts[hour] ?? 0) +
        (counts[(hour + 1) % WEEK_HOURS] ?? 0)) /
      4;
    return weight * (smoothed / weeks) + (1 - weight) * average;
  });

  // Recent sales against what the average expects of the same window.
  const recent = sales.filter((time) => time > nowMs - RECENT_HOURS * HOUR_MS).length;
  const expected = average * RECENT_HOURS;
  const heat = clamp((recent + 1) / (expected + 1), HEAT_RANGE[0], HEAT_RANGE[1]);

  // Walk forward until the expected sales reach a default interval's share.
  const target = average * (settings.defaultIntervalMs / HOUR_MS);
  let covered = 0;
  let cursor = nowMs;
  const limit = nowMs + settings.maxIntervalMs;
  while (cursor < limit) {
    const hourEnd = (Math.floor(cursor / HOUR_MS) + 1) * HOUR_MS;
    const sliceHours = (Math.min(hourEnd, limit) - cursor) / HOUR_MS;
    const perHour = (rate[hourOfWeek(cursor)] ?? average) * heat;
    if (covered + perHour * sliceHours >= target) {
      cursor += ((target - covered) / perHour) * HOUR_MS;
      break;
    }
    covered += perHour * sliceHours;
    cursor += sliceHours * HOUR_MS;
  }
  const delayMs = clamp(Math.round(cursor - nowMs), settings.minIntervalMs, settings.maxIntervalMs);
  return { delayMs, basis: 'history' };
}

/** 0 for Monday 00:00 UTC through 167 for Sunday 23:00. */
function hourOfWeek(timeMs: number): number {
  const date = new Date(timeMs);
  return ((date.getUTCDay() + 6) % 7) * 24 + date.getUTCHours();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
