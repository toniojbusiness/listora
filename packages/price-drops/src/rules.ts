/**
 * The price drop rules with no I/O (docs/features/price-drops.md): when a live listing's next
 * drop is due, what price it drops to, and the defaults a new rule starts from, taken from the
 * seller's own days to sell.
 *
 * A rule reads "take `percent`% off after `afterDays` days unsold, never below `floor`". A
 * listing is unsold since it went live or its price last changed (by the seller or a drop), so
 * after a drop the clock starts again: 10% off every 21 days, down to the floor. Prices land on
 * whole dollars, rounded down, and never below the floor rounded up to a whole dollar.
 */
import { medianCents } from '@listora/sourcing';

/** A rule's terms. */
export interface DropTerms {
  /** Taken off the price at each drop, 1 to 50. */
  percent: number;
  /** Days unsold before each drop, 1 to 365. */
  afterDays: number;
  /** No drop goes below this, in cents. */
  floorCents: number;
}

export const PERCENT_RANGE = { min: 1, max: 50 } as const;
export const AFTER_DAYS_RANGE = { min: 1, max: 365 } as const;

/**
 * Hours after a rule takes effect (made, changed, or turned back on) before any of its drops
 * may run: the seller always sees a planned drop a day ahead and can turn the rule off.
 */
export const DROP_NOTICE_HOURS = 24;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const DOLLAR = 100;

/**
 * The price the listing drops to from `priceCents`, or null when it is at its floor already (a
 * drop would not lower it). `itemFloorCents` is the item's own "don't sell below" price, which
 * no drop crosses either.
 */
export function nextDropPrice(
  priceCents: number,
  terms: Pick<DropTerms, 'percent' | 'floorCents'>,
  itemFloorCents: number | null = null,
): number | null {
  const floor = dropFloor(terms.floorCents, itemFloorCents);
  const lowered = Math.floor((priceCents * (100 - terms.percent)) / 100 / DOLLAR) * DOLLAR;
  const next = Math.max(lowered, floor);
  return next < priceCents ? next : null;
}

/** The lowest price a drop may set: the rule's floor or the item's, the higher, in whole dollars. */
export function dropFloor(ruleFloorCents: number, itemFloorCents: number | null): number {
  const floor = Math.max(ruleFloorCents, itemFloorCents ?? 0);
  return Math.ceil(floor / DOLLAR) * DOLLAR;
}

/**
 * When the listing's next drop is due: `afterDays` after it was last unsold-from (live, or its
 * last price change), but never sooner than `DROP_NOTICE_HOURS` after the rule took effect.
 */
export function dropDueAt(unsoldSince: Date, afterDays: number, armedAt: Date): Date {
  return new Date(
    Math.max(
      unsoldSince.getTime() + afterDays * DAY_MS,
      armedAt.getTime() + DROP_NOTICE_HOURS * HOUR_MS,
    ),
  );
}

/** The terms a new rule starts from when the seller has no sales to go by. */
export const FALLBACK_TERMS = { percent: 10, afterDays: 21 } as const;

/** Sales needed before their days to sell set a default (a brand's, or all of them). */
export const MIN_SALES_FOR_DEFAULT = 3;

/** A default from days to sell is held to this range: never a drop within a week. */
export const DEFAULT_AFTER_DAYS_RANGE = { min: 7, max: 90 } as const;

/** What a new rule's days default to, and what they rest on. */
export interface DropDefaults {
  percent: number;
  afterDays: number;
  /** The sales the days come from; absent: the fallback (too few sales). */
  basis?: { sales: number; medianDays: number; brand?: string };
}

/**
 * A new rule's default terms from the seller's own days to sell: the median of the brand's sales
 * when it has `MIN_SALES_FOR_DEFAULT`, else of all their sales, else the fallback. Half their
 * items like it sold by then, so one still unsold after it is slower than usual.
 */
export function dropDefaults(
  allDays: readonly number[],
  brand?: { name: string; days: readonly number[] },
): DropDefaults {
  const pick =
    brand !== undefined && brand.days.length >= MIN_SALES_FOR_DEFAULT
      ? { days: brand.days, brand: brand.name }
      : allDays.length >= MIN_SALES_FOR_DEFAULT
        ? { days: allDays }
        : undefined;
  if (pick === undefined) return { ...FALLBACK_TERMS };
  // medianCents works on any whole numbers; days are rounded to whole days first.
  const medianDays =
    medianCents(pick.days.map((days) => Math.max(0, Math.round(days)))) ?? FALLBACK_TERMS.afterDays;
  const afterDays = Math.min(
    DEFAULT_AFTER_DAYS_RANGE.max,
    Math.max(DEFAULT_AFTER_DAYS_RANGE.min, Math.round(medianDays)),
  );
  return {
    percent: FALLBACK_TERMS.percent,
    afterDays,
    basis: {
      sales: pick.days.length,
      medianDays,
      ...(pick.brand === undefined ? {} : { brand: pick.brand }),
    },
  };
}

/** Why terms are refused, with the field it is about. */
export class InvalidDropRuleError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidDropRuleError';
    this.field = field;
  }
}

/** Refuses terms out of range, in words the seller can act on. */
export function assertDropTerms(terms: DropTerms): void {
  if (
    !Number.isInteger(terms.percent) ||
    terms.percent < PERCENT_RANGE.min ||
    terms.percent > PERCENT_RANGE.max
  ) {
    throw new InvalidDropRuleError(
      'percent',
      `Pick a drop between ${String(PERCENT_RANGE.min)}% and ${String(PERCENT_RANGE.max)}%.`,
    );
  }
  if (
    !Number.isInteger(terms.afterDays) ||
    terms.afterDays < AFTER_DAYS_RANGE.min ||
    terms.afterDays > AFTER_DAYS_RANGE.max
  ) {
    throw new InvalidDropRuleError(
      'afterDays',
      `Pick between ${String(AFTER_DAYS_RANGE.min)} and ${String(AFTER_DAYS_RANGE.max)} days.`,
    );
  }
  if (!Number.isInteger(terms.floorCents) || terms.floorCents < DOLLAR) {
    throw new InvalidDropRuleError('floor', 'Enter a lowest price of at least $1.');
  }
}
