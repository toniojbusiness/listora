/**
 * Deleting a marketplace connection's data (docs/features/privacy.md): when the seller unlinks
 * the marketplace (`disconnectConnection`), when its access stayed revoked past the retention
 * period (the retention job), or when the marketplace ended Listora's access (an operator's
 * purge, `npm run admin -- marketplace-purge`).
 *
 * `startConnectionDeletion` deletes, in the caller's transaction, everything Listora holds that
 * came from the seller's marketplace account through that connection:
 *
 * - the connection itself: its encrypted OAuth tokens or browser session, the marketplace's user
 *   id and name, its health and errors; with it go its automation runs, session checks,
 *   sale-check schedule, and the work waiting for the seller's iPhone (foreign-key cascades),
 *   and connect attempts lose their link;
 * - the listings' read-backs from the marketplace (`remote_snapshot`) and their link to the
 *   connection, so nothing can act on them through it again; they are marked as the unlinked
 *   shop's (`shop_unlinked_at`), so the next link, which may be another shop, never takes them;
 * - the marketplace events about that seller in the account (webhook and poll payloads).
 *
 * The seller's own records stay: items, listings and their history, sales, and fees. Then it
 * leaves a tombstone (`connection_deletion`) and its job, which does what needs outside
 * services: it asks the marketplace to revoke the grant (an OAuth connection's tokens are kept,
 * encrypted, only for that), deletes the automation screenshots, checks that nothing is left,
 * and writes the deletion's completion record (`deletion_record`).
 */
import {
  DELETION_COMPLETION_DEADLINE_MS,
  recordDeletion,
  type ConnectionDeletionReason,
  type ConnectionDeletionTable,
  type Db,
  type DbExecutor,
  type DbTransaction,
  type Marketplace,
} from '@listora/db';
import type { Logger } from '@listora/shared';
import { purgeObjects, type ObjectStorage } from '@listora/storage';
import { sql, type Selectable } from 'kysely';

import type { GrantTokens } from './revoker.ts';

/** The Graphile Worker task that finishes a connection deletion. */
export const CONNECTION_DELETION_TASK = 'connection_deletion';

/** Never dropped: Graphile retries a job that throws (a database outage) with its own backoff. */
const CONNECTION_DELETION_JOB_MAX_ATTEMPTS = 32_767;

export function connectionDeletionJobKey(deletionId: string): string {
  return `connection_deletion:${deletionId}`;
}

export interface ConnectionDeletionJobPayload {
  deletionId: string;
}

function isConnectionDeletionJobPayload(value: unknown): value is ConnectionDeletionJobPayload {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as Record<string, unknown>)['deletionId'] === 'string';
}

/** Adds (or replaces) the deletion's job, to run at `runAt` (`null` runs it now). */
export async function scheduleConnectionDeletionJob(
  executor: DbExecutor,
  deletionId: string,
  runAt: Date | null,
): Promise<void> {
  const payload: ConnectionDeletionJobPayload = { deletionId };
  await sql`
    select graphile_worker.add_job(
      identifier => ${CONNECTION_DELETION_TASK},
      payload => ${JSON.stringify(payload)}::json,
      run_at => ${runAt}::timestamptz,
      max_attempts => ${CONNECTION_DELETION_JOB_MAX_ATTEMPTS},
      job_key => ${connectionDeletionJobKey(deletionId)},
      job_key_mode => 'replace'
    )
  `.execute(executor);
}

/** What `deleteConnectionData` deleted. */
export interface DeletedConnectionData {
  marketplace: Marketplace;
  /** Listings that lost their read-back and their link to the connection. */
  listings: number;
  /** Marketplace events about the seller. */
  inboundEvents: number;
  /** Automation runs of the connection (deleted with it). */
  automationRuns: number;
  /** The screenshots those runs kept, to delete from storage after the commit. */
  screenshotKeys: string[];
  /** The OAuth grant's encrypted tokens, when the marketplace has not revoked it yet. */
  grantCiphertext: Buffer | null;
}

/**
 * Deletes the connection and the marketplace data that came through it, on the caller's
 * transaction. Undefined when the account has no such connection.
 */
export async function deleteConnectionData(
  trx: DbTransaction,
  connection: { accountId: string; connectionId: string },
): Promise<DeletedConnectionData | undefined> {
  const { accountId, connectionId } = connection;
  const row = await trx
    .selectFrom('marketplace_connection')
    .select(['marketplace', 'mode', 'status', 'external_user_id', 'token_ciphertext'])
    .where('account_id', '=', accountId)
    .where('id', '=', connectionId)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const runs = await trx
    .selectFrom('automation_run')
    .select('screenshot_key')
    .where('account_id', '=', accountId)
    .where('connection_id', '=', connectionId)
    .execute();
  const listings = await trx
    .updateTable('marketplace_listing')
    // From now on they are the unlinked shop's: a later link (maybe of another shop) never
    // takes them, unless its import finds them in that shop.
    .set({ connection_id: null, remote_snapshot: null, shop_unlinked_at: sql<Date>`now()` })
    .where('account_id', '=', accountId)
    .where('connection_id', '=', connectionId)
    .executeTakeFirst();
  const events =
    row.external_user_id === null
      ? undefined
      : await trx
          .deleteFrom('inbound_event')
          .where('account_id', '=', accountId)
          .where('marketplace', '=', row.marketplace)
          .where('external_user_id', '=', row.external_user_id)
          .executeTakeFirst();
  await trx
    .deleteFrom('marketplace_connection')
    .where('account_id', '=', accountId)
    .where('id', '=', connectionId)
    .execute();
  return {
    marketplace: row.marketplace,
    listings: Number(listings.numUpdatedRows),
    inboundEvents: Number(events?.numDeletedRows ?? 0),
    automationRuns: runs.length,
    screenshotKeys: runs.flatMap((run) =>
      run.screenshot_key === null ? [] : [run.screenshot_key],
    ),
    grantCiphertext: row.mode === 'api' && row.status !== 'revoked' ? row.token_ciphertext : null,
  };
}

export interface StartedConnectionDeletion {
  deletionId: string;
  deleted: DeletedConnectionData;
}

/**
 * Deletes the connection's data (`deleteConnectionData`) and leaves the tombstone and job that
 * finish the deletion, all on the caller's transaction. Undefined when there is no such
 * connection.
 */
export async function startConnectionDeletion(
  trx: DbTransaction,
  connection: { accountId: string; connectionId: string; reason: ConnectionDeletionReason },
): Promise<StartedConnectionDeletion | undefined> {
  const deleted = await deleteConnectionData(trx, connection);
  if (deleted === undefined) return undefined;
  const { id: deletionId } = await trx
    .insertInto('connection_deletion')
    .values({
      connection_id: connection.connectionId,
      marketplace: deleted.marketplace,
      reason: connection.reason,
      token_ciphertext: deleted.grantCiphertext,
      revocation: deleted.grantCiphertext === null ? 'none' : 'pending',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const keys = [...new Set(deleted.screenshotKeys)];
  if (keys.length > 0) {
    await trx
      .insertInto('connection_deletion_object')
      .values(keys.map((key) => ({ deletion_id: deletionId, storage_key: key })))
      .execute();
  }
  await scheduleConnectionDeletionJob(trx, deletionId, null);
  return { deletionId, deleted };
}

/**
 * Deletes the data of every connection to `marketplace` in `mode`, in every account: what an
 * operator runs when a marketplace ends Listora's access (Depop's partner terms require deleting
 * Depop data then). Each connection is its own transaction and deletion (with its job), so a
 * failure part way leaves the rest for a rerun. With `dryRun`, only counts them.
 */
export async function purgeMarketplaceConnections(
  db: Db,
  target: { marketplace: Marketplace; mode: 'api' | 'automation' },
  options: { dryRun: boolean },
): Promise<{ connections: number }> {
  const rows = await db
    .selectFrom('marketplace_connection')
    .select(['account_id', 'id'])
    .where('marketplace', '=', target.marketplace)
    .where('mode', '=', target.mode)
    .orderBy('id')
    .execute();
  if (options.dryRun) return { connections: rows.length };
  let connections = 0;
  for (const row of rows) {
    const started = await db.transaction().execute((trx) =>
      startConnectionDeletion(trx, {
        accountId: row.account_id,
        connectionId: row.id,
        reason: 'marketplace_terminated',
      }),
    );
    if (started !== undefined) connections += 1;
  }
  return { connections };
}

/** Revokes a grant through the marketplace's official endpoint (`OAuthGrantRevoker`). */
export interface GrantRevoker {
  /** True only when the marketplace confirmed; it must be safe to ask again. */
  revoke(grant: GrantTokens): Promise<boolean>;
}

export interface ConnectionDeletionPolicy {
  /** The wait after run n is `delaysMs[min(n, length) - 1]` (the last one repeats). */
  readonly delaysMs: readonly number[];
  /** How long the job keeps asking the marketplace to revoke the grant. */
  readonly revocationWindowMs: number;
  /** A deletion still open past this is overdue (logged as an error, and alarmed). */
  readonly completionDeadlineMs: number;
}

/** The account deletion's schedule: 1 m, 5 m, 15 m, 1 h, 3 h, then every 6 h; done in 8 days. */
export const DEFAULT_CONNECTION_DELETION_POLICY: ConnectionDeletionPolicy = {
  delaysMs: [60_000, 300_000, 900_000, 3_600_000, 10_800_000, 21_600_000],
  revocationWindowMs: 7 * 86_400_000,
  completionDeadlineMs: DELETION_COMPLETION_DEADLINE_MS,
};

export interface ConnectionDeletionDependencies {
  db: Db;
  /** Undefined when the worker cannot revoke (no token vault): grants end as `manual`. */
  revoker: GrantRevoker | undefined;
  storage: ObjectStorage;
  logger: Logger;
  policy?: ConnectionDeletionPolicy;
  /** Milliseconds since the epoch; injectable for tests. */
  now?: () => number;
}

export type ConnectionDeletionOutcome = 'completed' | 'retrying' | 'not_found';

type DeletionRow = Selectable<ConnectionDeletionTable>;

/**
 * Runs the deletion's job once: revokes the grant while pending (giving up, as `manual`, when
 * the window ends), deletes the stored objects and checks them gone, checks that no row still
 * references the connection, and then records the deletion and deletes the tombstone. Otherwise
 * it schedules the next run. Each step's result is committed before the next, and each is safe
 * to repeat. Throws only when the database fails.
 */
export async function completeConnectionDeletion(
  deps: ConnectionDeletionDependencies,
  deletionId: string,
): Promise<ConnectionDeletionOutcome> {
  const { db } = deps;
  const policy = deps.policy ?? DEFAULT_CONNECTION_DELETION_POLICY;
  const now = deps.now ?? Date.now;
  const deletion = await db
    .selectFrom('connection_deletion')
    .selectAll()
    .where('id', '=', deletionId)
    .executeTakeFirst();
  if (!deletion) return 'not_found';
  const log = deps.logger.child({
    connectionDeletionId: deletionId,
    connectionId: deletion.connection_id,
    marketplace: deletion.marketplace,
  });

  const revocation = await settleRevocation(deps, deletion, policy, now(), log);
  const objectsDeleted = await deleteObjects(deps, deletion, log);
  const left = await remainingRows(db, deletion.connection_id);
  if (left.length > 0) {
    log.error({ remainingRows: left }, 'rows of a deleted connection remain; not completing');
  }

  if (revocation !== 'pending' && objectsDeleted && left.length === 0) {
    await db.transaction().execute(async (trx) => {
      await recordDeletion(trx, {
        id: deletionId,
        kind: 'connection',
        reason: deletion.reason,
        marketplace: deletion.marketplace,
        requestedAt: deletion.requested_at,
        summary: {
          revocation,
          verified: { rows: 0, objects: 0 },
          attempts: deletion.attempts + 1,
        },
      });
      await trx.deleteFrom('connection_deletion').where('id', '=', deletionId).execute();
    });
    if (revocation === 'manual') {
      log.warn('gave up revoking marketplace access of a deleted connection; the seller must');
    }
    log.info({ revocation }, 'connection deletion completed');
    return 'completed';
  }

  const windowEndsAt = deletion.requested_at.getTime() + policy.revocationWindowMs;
  if (now() - deletion.requested_at.getTime() > policy.completionDeadlineMs) {
    log.error(
      {
        event: 'connection_deletion_overdue',
        revocation,
        objectsDeleted,
        rowsLeft: left.length,
      },
      'connection deletion is overdue',
    );
  }
  await db.transaction().execute(async (trx) => {
    const { attempts } = await trx
      .updateTable('connection_deletion')
      .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
      .where('id', '=', deletionId)
      .returning('attempts')
      .executeTakeFirstOrThrow();
    const delay = policy.delaysMs[Math.min(attempts, policy.delaysMs.length) - 1] ?? 0;
    let runAt = now() + delay;
    // The revocation gets one last try when the window ends.
    if (revocation === 'pending') runAt = Math.min(runAt, Math.max(windowEndsAt, now()));
    await scheduleConnectionDeletionJob(trx, deletionId, new Date(runAt));
  });
  return 'retrying';
}

/** The Graphile Worker task for `CONNECTION_DELETION_TASK`. */
export function connectionDeletionTask(
  deps: ConnectionDeletionDependencies,
): (payload: unknown) => Promise<void> {
  return async (payload) => {
    if (!isConnectionDeletionJobPayload(payload)) {
      deps.logger.error('connection deletion job with an invalid payload; dropping it');
      return;
    }
    await completeConnectionDeletion(deps, payload.deletionId);
  };
}

/** Asks the marketplace to revoke a pending grant; returns the grant's state after this run. */
async function settleRevocation(
  deps: ConnectionDeletionDependencies,
  deletion: DeletionRow,
  policy: ConnectionDeletionPolicy,
  now: number,
  log: Logger,
): Promise<'none' | 'pending' | 'revoked' | 'manual'> {
  if (deletion.revocation !== 'pending' || deletion.token_ciphertext === null) {
    return deletion.revocation;
  }
  let revoked = false;
  if (deps.revoker !== undefined) {
    try {
      revoked = await deps.revoker.revoke({
        connectionId: deletion.connection_id,
        marketplace: deletion.marketplace,
        tokenCiphertext: deletion.token_ciphertext,
      });
    } catch (error) {
      log.warn({ err: error }, 'marketplace access could not be revoked');
    }
  }
  const windowEnded = now >= deletion.requested_at.getTime() + policy.revocationWindowMs;
  if (!revoked && !windowEnded) return 'pending';
  const outcome = revoked ? 'revoked' : 'manual';
  // The tokens go with the outcome: a revoked grant is worthless, and one given up on must not
  // be kept.
  await deps.db
    .updateTable('connection_deletion')
    .set({ revocation: outcome, token_ciphertext: null })
    .where('id', '=', deletion.id)
    .execute();
  return outcome;
}

/** Deletes the deletion's stored objects; true once storage has none of them left. */
async function deleteObjects(
  deps: ConnectionDeletionDependencies,
  deletion: DeletionRow,
  log: Logger,
): Promise<boolean> {
  const rows = await deps.db
    .selectFrom('connection_deletion_object')
    .select('storage_key')
    .where('deletion_id', '=', deletion.id)
    .execute();
  if (rows.length === 0) return true;
  const result = await purgeObjects(deps.storage, { keys: rows.map((row) => row.storage_key) });
  const settled = rows
    .map((row) => row.storage_key)
    .filter((key) => !result.remaining.includes(key));
  if (settled.length > 0) {
    await deps.db
      .deleteFrom('connection_deletion_object')
      .where('deletion_id', '=', deletion.id)
      .where('storage_key', 'in', settled)
      .execute();
  }
  if (result.remaining.length > 0) {
    log.warn(
      { remaining: result.remaining.length },
      'could not delete every stored object of a deleted connection yet; retrying',
    );
    return false;
  }
  return true;
}

/** Tables that still reference the deleted connection. */
async function remainingRows(db: Db, connectionId: string): Promise<string[]> {
  const { rows } = await sql<{ table_name: string }>`
    select 'marketplace_connection' as table_name from marketplace_connection
      where id = ${connectionId}
    union all select 'marketplace_listing' from marketplace_listing
      where connection_id = ${connectionId}
    union all select 'automation_run' from automation_run where connection_id = ${connectionId}
    union all select 'session_check' from session_check where connection_id = ${connectionId}
    union all select 'phone_work' from phone_work where connection_id = ${connectionId}
    union all select 'sale_check_schedule' from sale_check_schedule
      where connection_id = ${connectionId}
    union all select 'sale_check_run' from sale_check_run where connection_id = ${connectionId}
    union all select 'connection_authorization' from connection_authorization
      where connection_id = ${connectionId}
  `.execute(db);
  return [...new Set(rows.map((row) => row.table_name))];
}
