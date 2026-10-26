import type { DbExecutor } from '@listora/db';

import type { Tenant } from '../tenancy.ts';

/** The signed-in person as Settings shows them; null means never entered (or cleared). */
export interface ProfileRow {
  email: string | null;
  displayName: string | null;
  businessName: string | null;
}

/** The person's email and name, and their account's business name. */
export async function loadProfile(db: DbExecutor, tenant: Tenant): Promise<ProfileRow> {
  return db
    .selectFrom('app_user')
    .innerJoin('account', (join) => join.on('account.id', '=', tenant.accountId))
    .select([
      'app_user.email as email',
      'app_user.display_name as displayName',
      'account.business_name as businessName',
    ])
    .where('app_user.id', '=', tenant.userId)
    .executeTakeFirstOrThrow();
}

/** Saves both names (null clears one), in the caller's transaction. */
export async function saveProfile(
  trx: DbExecutor,
  tenant: Tenant,
  names: { displayName: string | null; businessName: string | null },
): Promise<void> {
  await trx
    .updateTable('app_user')
    .set({ display_name: names.displayName })
    .where('id', '=', tenant.userId)
    .execute();
  await trx
    .updateTable('account')
    .set({ business_name: names.businessName })
    .where('id', '=', tenant.accountId)
    .execute();
}
