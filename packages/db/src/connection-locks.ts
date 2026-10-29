/**
 * The lock order of work on marketplace connections with their deletion
 * (docs/features/privacy.md#unlinking-while-work-runs).
 */
import type { DbTransaction } from './database.ts';

/**
 * Takes the lock that orders work on connections with their deletion: `for key share` on each
 * connection's row, in id order. A transaction that writes a connection's rows (its phone work,
 * runs, checks, schedules, imports, offers, read health) takes it before it locks any of them.
 * Deleting a connection (an unlink) locks its row first and then deletes those rows, so work
 * that held one of them and then needed the connection (any insert that references it does)
 * deadlocked with an unlink. With the lock, the unlink waits for the work to commit, or the work
 * for the unlink, and then finds the connection gone. It blocks only deleting the connection and
 * changing its key, never another transaction's work on it. Returns the ids of the connections
 * that exist.
 */
export async function lockConnections(
  trx: DbTransaction,
  accountId: string,
  connectionIds: readonly string[],
): Promise<Set<string>> {
  if (connectionIds.length === 0) return new Set();
  const rows = await trx
    .selectFrom('marketplace_connection')
    .select('id')
    .where('account_id', '=', accountId)
    .where('id', 'in', [...new Set(connectionIds)])
    .orderBy('id')
    .forKeyShare()
    .execute();
  return new Set(rows.map((row) => row.id));
}
