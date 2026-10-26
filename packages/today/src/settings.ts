/**
 * The morning summary's setting, one per account: on or off, the time, and the time zone the
 * time is in. An account that never saved one gets the defaults, except that the summary waits
 * for a time zone, which only the app knows.
 */
import type { DbExecutor } from '@listora/db';
import { sql } from 'kysely';

export interface TodaySummarySettings {
  enabled: boolean;
  /** Wall-clock `HH:MM` in `timeZone`. */
  localTime: string;
  /** An IANA time zone name; null until the app sends one. */
  timeZone: string | null;
}

export const DEFAULT_SUMMARY_SETTINGS: TodaySummarySettings = {
  enabled: true,
  localTime: '08:00',
  timeZone: null,
};

const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export class InvalidSummarySettingsError extends Error {
  readonly field: 'localTime' | 'timeZone';

  constructor(field: 'localTime' | 'timeZone', message: string) {
    super(message);
    this.name = 'InvalidSummarySettingsError';
    this.field = field;
  }
}

export async function loadSummarySettings(
  executor: DbExecutor,
  accountId: string,
): Promise<TodaySummarySettings> {
  const row = await executor
    .selectFrom('today_summary_setting')
    .select(['enabled', 'local_time', 'time_zone'])
    .where('account_id', '=', accountId)
    .executeTakeFirst();
  if (row === undefined) return DEFAULT_SUMMARY_SETTINGS;
  return { enabled: row.enabled, localTime: row.local_time.slice(0, 5), timeZone: row.time_zone };
}

/**
 * Saves the setting. The time zone must be one Postgres knows (`pg_timezone_names`), since the
 * summary job computes each account's local time there; anything else is refused.
 */
export async function saveSummarySettings(
  executor: DbExecutor,
  accountId: string,
  settings: TodaySummarySettings & { timeZone: string },
): Promise<TodaySummarySettings> {
  if (!LOCAL_TIME.test(settings.localTime)) {
    throw new InvalidSummarySettingsError(
      'localTime',
      'Pick a time as hours and minutes, like 08:00.',
    );
  }
  const known = await sql<{ name: string }>`
    select name from pg_timezone_names where name = ${settings.timeZone}
  `.execute(executor);
  if (known.rows.length === 0) {
    throw new InvalidSummarySettingsError('timeZone', 'This time zone is not one Listora knows.');
  }
  const row = await executor
    .insertInto('today_summary_setting')
    .values({
      account_id: accountId,
      enabled: settings.enabled,
      local_time: settings.localTime,
      time_zone: settings.timeZone,
    })
    .onConflict((conflict) =>
      conflict.column('account_id').doUpdateSet({
        enabled: settings.enabled,
        local_time: settings.localTime,
        time_zone: settings.timeZone,
      }),
    )
    .returning(['enabled', 'local_time', 'time_zone'])
    .executeTakeFirstOrThrow();
  return { enabled: row.enabled, localTime: row.local_time.slice(0, 5), timeZone: row.time_zone };
}
