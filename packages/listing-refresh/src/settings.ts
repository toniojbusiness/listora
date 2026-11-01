/**
 * The refresh settings: one per account (the cadence, the quiet window, and whether a refresh
 * may relist), and an item's own cadence over it. An account that never saved one refreshes
 * every 72 hours with no quiet window, and never relists.
 */
import type { DbExecutor, RefreshCadence } from '@listora/db';
import { sql } from 'kysely';

import {
  CUSTOM_HOURS,
  DEFAULT_REFRESH_CADENCE,
  type Cadence,
  type QuietWindow,
} from './cadence.ts';

export interface RefreshSettings extends Cadence {
  /** Minutes after midnight in `timeZone`; both or neither. */
  quietStart: number | null;
  quietEnd: number | null;
  /** An IANA time zone name; null until the app sends one. */
  timeZone: string | null;
  /**
   * Whether listings on a marketplace whose refresh is a repost (Depop) are refreshed: a fresh
   * copy posted and the old listing deleted, which resets its likes and saves. Off by default.
   */
  relistToRefresh: boolean;
}

export const DEFAULT_REFRESH_SETTINGS: RefreshSettings = {
  cadence: DEFAULT_REFRESH_CADENCE,
  customHours: null,
  quietStart: null,
  quietEnd: null,
  timeZone: null,
  relistToRefresh: false,
};

export type RefreshSettingsField = 'customHours' | 'quietWindow' | 'timeZone';

export class InvalidRefreshSettingsError extends Error {
  readonly field: RefreshSettingsField;

  constructor(field: RefreshSettingsField, message: string) {
    super(message);
    this.name = 'InvalidRefreshSettingsError';
    this.field = field;
  }
}

/** The quiet window the settings name, when they name one. */
export function quietWindowOf(settings: RefreshSettings): QuietWindow | null {
  if (settings.quietStart === null || settings.quietEnd === null || settings.timeZone === null) {
    return null;
  }
  return { start: settings.quietStart, end: settings.quietEnd, timeZone: settings.timeZone };
}

export async function loadRefreshSettings(
  executor: DbExecutor,
  accountId: string,
): Promise<RefreshSettings> {
  const row = await executor
    .selectFrom('listing_refresh_setting')
    .select([
      'cadence',
      'custom_hours',
      'quiet_start',
      'quiet_end',
      'time_zone',
      'relist_to_refresh',
    ])
    .where('account_id', '=', accountId)
    .executeTakeFirst();
  if (row === undefined) return DEFAULT_REFRESH_SETTINGS;
  return {
    cadence: row.cadence,
    customHours: row.custom_hours,
    quietStart: row.quiet_start,
    quietEnd: row.quiet_end,
    timeZone: row.time_zone,
    relistToRefresh: row.relist_to_refresh,
  };
}

/**
 * Saves the account's setting. A custom cadence needs its hours (and only it has them), a quiet
 * window needs a start and an end that differ, and the time zone must be one Postgres knows
 * (`pg_timezone_names`), since the schedule computes the seller's local time there.
 */
export async function saveRefreshSettings(
  executor: DbExecutor,
  accountId: string,
  settings: RefreshSettings & { timeZone: string },
): Promise<RefreshSettings> {
  const customHours = checkedCustomHours(settings);
  const { quietStart, quietEnd } = settings;
  if ((quietStart === null) !== (quietEnd === null)) {
    throw new InvalidRefreshSettingsError(
      'quietWindow',
      'A quiet window needs a start and an end.',
    );
  }
  if (quietStart !== null && quietStart === quietEnd) {
    throw new InvalidRefreshSettingsError(
      'quietWindow',
      'A quiet window must end after it starts.',
    );
  }
  const known = await sql<{ name: string }>`
    select name from pg_timezone_names where name = ${settings.timeZone}
  `.execute(executor);
  if (known.rows.length === 0) {
    throw new InvalidRefreshSettingsError('timeZone', 'This time zone is not one Listora knows.');
  }
  const values = {
    cadence: settings.cadence,
    custom_hours: customHours,
    quiet_start: quietStart,
    quiet_end: quietEnd,
    time_zone: settings.timeZone,
    relist_to_refresh: settings.relistToRefresh,
  };
  const row = await executor
    .insertInto('listing_refresh_setting')
    .values({ account_id: accountId, ...values })
    .onConflict((conflict) => conflict.column('account_id').doUpdateSet(values))
    .returning([
      'cadence',
      'custom_hours',
      'quiet_start',
      'quiet_end',
      'time_zone',
      'relist_to_refresh',
    ])
    .executeTakeFirstOrThrow();
  return {
    cadence: row.cadence,
    customHours: row.custom_hours,
    quietStart: row.quiet_start,
    quietEnd: row.quiet_end,
    timeZone: row.time_zone,
    relistToRefresh: row.relist_to_refresh,
  };
}

/**
 * Sets an item's own cadence (`null`: the account's again). Returns `false` when the account
 * has no such item.
 */
export async function saveItemRefresh(
  executor: DbExecutor,
  accountId: string,
  itemId: string,
  cadence: Cadence | null,
): Promise<boolean> {
  const customHours = cadence === null ? null : checkedCustomHours(cadence);
  const result = await executor
    .updateTable('inventory_item')
    .set({ refresh_cadence: cadence?.cadence ?? null, refresh_custom_hours: customHours })
    .where('account_id', '=', accountId)
    .where('id', '=', itemId)
    .executeTakeFirst();
  return result.numUpdatedRows > 0n;
}

/** An item's own cadence from its columns; `null` when it follows the account's. */
export function itemCadence(row: {
  refresh_cadence: RefreshCadence | null;
  refresh_custom_hours: number | null;
}): Cadence | null {
  return row.refresh_cadence === null
    ? null
    : { cadence: row.refresh_cadence, customHours: row.refresh_custom_hours };
}

function checkedCustomHours(cadence: Cadence): number | null {
  if (cadence.cadence !== 'custom') return null;
  const hours = cadence.customHours;
  if (
    hours === null ||
    !Number.isSafeInteger(hours) ||
    hours < CUSTOM_HOURS.min ||
    hours > CUSTOM_HOURS.max
  ) {
    throw new InvalidRefreshSettingsError(
      'customHours',
      `Pick a custom time from ${String(CUSTOM_HOURS.min)} hours to ${String(CUSTOM_HOURS.max / 24)} days.`,
    );
  }
  return hours;
}
