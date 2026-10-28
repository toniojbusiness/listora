/** Whether Pack check is on for an account (docs/features/pack-check.md): off until turned on. */
import type { DbExecutor } from '@listora/db';

export interface PackCheckSettings {
  enabled: boolean;
}

export const DEFAULT_PACK_CHECK_SETTINGS: PackCheckSettings = { enabled: false };

export async function loadPackCheckSettings(
  executor: DbExecutor,
  accountId: string,
): Promise<PackCheckSettings> {
  const row = await executor
    .selectFrom('pack_check_setting')
    .select('enabled')
    .where('account_id', '=', accountId)
    .executeTakeFirst();
  return row === undefined ? DEFAULT_PACK_CHECK_SETTINGS : { enabled: row.enabled };
}

export async function savePackCheckSettings(
  executor: DbExecutor,
  accountId: string,
  settings: PackCheckSettings,
): Promise<PackCheckSettings> {
  const row = await executor
    .insertInto('pack_check_setting')
    .values({ account_id: accountId, enabled: settings.enabled })
    .onConflict((conflict) =>
      conflict.column('account_id').doUpdateSet({ enabled: settings.enabled }),
    )
    .returning('enabled')
    .executeTakeFirstOrThrow();
  return { enabled: row.enabled };
}

/** Whether Pack check is on: only then does Listora read labels when sales come in. */
export async function isPackCheckEnabled(
  executor: DbExecutor,
  accountId: string,
): Promise<boolean> {
  return (await loadPackCheckSettings(executor, accountId)).enabled;
}
