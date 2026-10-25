import { sql } from 'kysely';

import type { DbExecutor } from '@listora/db';

import type { OperationRow } from './transitions.ts';

/**
 * Whether any step of the operation started under a mode other than assisted, so its request
 * may have reached the marketplace. A `running` event without a recorded mode counts.
 */
export async function wasSentThroughApi(
  executor: DbExecutor,
  op: Pick<OperationRow, 'account_id' | 'id'>,
): Promise<boolean> {
  const event = await executor
    .selectFrom('operation_event')
    .select('id')
    .where('account_id', '=', op.account_id)
    .where('operation_id', '=', op.id)
    .where('to_status', '=', 'running')
    .where(sql<string | null>`detail->>'mode'`, 'is distinct from', 'assisted')
    .limit(1)
    .executeTakeFirst();
  return event !== undefined;
}
