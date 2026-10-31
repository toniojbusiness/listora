import type { DbExecutor } from '@listora/db';
import { sql } from 'kysely';

import type { SignUpPolicy, Tenant } from '../tenancy.ts';

/**
 * Whether the signed-in member may use Test mode (docs/features/test-mode.md): they are the
 * owner or an admin of an account that has it. That is the deployment owner's account, the
 * account whose owner signs in with `SIGN_UP_OWNER_EMAIL`, or an account the owner granted Test
 * mode to (`account.test_mode_granted_at`, set by `admin test-mode-access grant`). No other
 * account has Test mode; a deployment without an owner (`SIGN_UP=open`) has it only for a
 * granted account.
 */
export async function mayUseTestMode(
  db: DbExecutor,
  tenant: Tenant,
  signUp: SignUpPolicy,
): Promise<boolean> {
  if (tenant.role !== 'owner' && tenant.role !== 'admin') return false;
  const account = await db
    .selectFrom('account')
    .select('test_mode_granted_at')
    .where('id', '=', tenant.accountId)
    .executeTakeFirst();
  if (account !== undefined && account.test_mode_granted_at !== null) return true;
  if (signUp.mode !== 'invite' || signUp.ownerEmail === undefined) return false;
  const owner = await db
    .selectFrom('membership')
    .innerJoin('app_user', 'app_user.id', 'membership.user_id')
    .select('membership.user_id')
    .where('membership.account_id', '=', tenant.accountId)
    .where('membership.role', '=', 'owner')
    .where(sql<string>`lower(app_user.email)`, '=', signUp.ownerEmail)
    .executeTakeFirst();
  return owner !== undefined;
}
