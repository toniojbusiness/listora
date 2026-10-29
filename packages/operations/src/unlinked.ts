/**
 * When the owner unlinks a marketplace (docs/features/privacy.md, Unlinking a marketplace), its
 * listings leave Listora, and the operations on them become history only, as when an item is
 * deleted. Nothing is sent to the marketplace: what is still unfinished is settled here, and the
 * history moves onto each listing's `deleted_listing` row.
 */
import type { DbTransaction, Marketplace } from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';

import { dismissOpenTasks } from './commands.ts';
import { removeOperationJob } from './jobs.ts';
import { UNFINISHED_STATUSES } from './state-machine.ts';
import { transitionOperation, type OperationError, type Tracked } from './transitions.ts';

/** Why an unlink settled an operation, in its history. */
export const UNLINKED_REASON = 'marketplace_unlinked';

/** The error of a change that may have reached the marketplace when it was unlinked. */
export function unlinkedOperationError(marketplace: Marketplace): OperationError {
  const name = MARKETPLACE_NAMES[marketplace];
  return {
    code: UNLINKED_REASON,
    message: `${name} was unlinked before Listora could confirm this change, so Listora doesn't know whether it went through on ${name}.`,
  };
}

/**
 * Settles every unfinished operation on the account's listings on `marketplace`, without asking
 * the marketplace: one waiting to run, to retry, or for the seller is canceled (its job removed,
 * its tasks dismissed); one whose step may be under way (`running`, `verifying`) can be neither
 * canceled nor confirmed any more, so it fails, saying so. Returns how many it settled.
 */
export async function settleUnlinkedOperations(
  trx: DbTransaction,
  target: { accountId: string; marketplace: Marketplace },
): Promise<number> {
  const unfinished = await trx
    .selectFrom('marketplace_operation')
    .selectAll()
    .where('listing_id', 'is not', null)
    .$narrowType<Tracked>()
    .where('account_id', '=', target.accountId)
    .where('listing_id', 'in', (eb) =>
      eb
        .selectFrom('marketplace_listing')
        .select('id')
        .where('account_id', '=', target.accountId)
        .where('marketplace', '=', target.marketplace),
    )
    .where('status', 'in', UNFINISHED_STATUSES)
    .orderBy('created_at')
    .orderBy('id')
    .forUpdate()
    .execute();
  for (const op of unfinished) {
    const detail = { action: 'unlink', reason: UNLINKED_REASON };
    if (op.status === 'running' || op.status === 'verifying') {
      await transitionOperation(
        trx,
        op,
        { to: 'failed', error: unlinkedOperationError(target.marketplace) },
        detail,
      );
    } else {
      await transitionOperation(trx, op, { to: 'canceled' }, detail);
    }
    await removeOperationJob(trx, op.id);
    await dismissOpenTasks(trx, op);
  }
  return unfinished.length;
}
