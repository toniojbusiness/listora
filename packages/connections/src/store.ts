/**
 * Reading and recording connection state (`marketplace_connection`). Status changes go through
 * `recordHealth`, so a connection's status, `last_ok_at`, and its latest problem always agree.
 */
import type { Selectable } from 'kysely';

import {
  inTransaction,
  type ConnectionStatus,
  type DbExecutor,
  type Marketplace,
  type MarketplaceConnectionTable,
} from '@listora/db';

import { notifyConnectionBroken, WORKING_STATUSES } from './notifications.ts';

export type ConnectionRow = Selectable<MarketplaceConnectionTable>;

/** A problem to show on the connection: machine code and a user-readable message. */
export interface ConnectionProblem {
  code: string;
  message: string;
}

/** The account's connections, at most one per marketplace (oldest first if more exist). */
export async function accountConnections(
  db: DbExecutor,
  accountId: string,
): Promise<Map<Marketplace, ConnectionRow>> {
  const rows = await db
    .selectFrom('marketplace_connection')
    .selectAll()
    .where('account_id', '=', accountId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const byMarketplace = new Map<Marketplace, ConnectionRow>();
  for (const row of rows) {
    if (!byMarketplace.has(row.marketplace)) byMarketplace.set(row.marketplace, row);
  }
  return byMarketplace;
}

export type HealthUpdate =
  /** The marketplace accepted the connection's access just now. */
  | { status: 'connected'; displayName?: string | null }
  | ({ status: Exclude<ConnectionStatus, 'connected'> } & ConnectionProblem);

/**
 * Records what the latest check or use of a connection showed. `connected` clears the problem
 * and moves `last_ok_at`; anything else records the problem. Either way `last_checked_at`
 * moves. A revoked connection loses its tokens, which are worthless. Only API connections that
 * still hold their grant change: once a connection needs the seller (reauth_required, revoked),
 * only connecting again restores it. So a change to one of those is the moment the connection
 * breaks, and it queues the seller's notification in the same transaction.
 */
export async function recordHealth(
  db: DbExecutor,
  connectionId: string,
  update: HealthUpdate,
  now: Date,
): Promise<void> {
  await inTransaction(db, async (trx) => {
    let query = trx
      .updateTable('marketplace_connection')
      .where('id', '=', connectionId)
      .where('mode', '=', 'api')
      .where('status', 'in', WORKING_STATUSES)
      .returning(['account_id', 'marketplace']);
    if (update.status === 'connected') {
      query = query.set({
        status: 'connected',
        last_ok_at: now,
        last_checked_at: now,
        last_error: null,
        last_error_code: null,
        last_error_at: null,
        ...(update.displayName === undefined || update.displayName === null
          ? {}
          : { display_name: update.displayName }),
      });
    } else {
      query = query.set({
        status: update.status,
        last_checked_at: now,
        last_error: update.message,
        last_error_code: update.code,
        last_error_at: now,
        ...(update.status === 'revoked' ? { token_ciphertext: null } : {}),
      });
    }
    const changed = await query.executeTakeFirst();
    if (changed !== undefined && update.status !== 'connected' && update.status !== 'degraded') {
      await notifyConnectionBroken(
        trx,
        {
          connectionId,
          accountId: changed.account_id,
          marketplace: changed.marketplace,
          message: update.message,
        },
        now,
      );
    }
  });
}

/** How long a requested check may take before the app stops showing it as running. */
export const CHECK_PENDING_MS = 10 * 60_000;

/**
 * Notes the seller's request to check a connection now ("Retry check"); the worker's
 * `connection_health_check` job runs it. Returns false when the connection is not one a check
 * can change (only connected and degraded API connections are checked).
 */
export async function requestHealthCheck(
  db: DbExecutor,
  connectionId: string,
  now: Date,
): Promise<boolean> {
  const row = await db
    .updateTable('marketplace_connection')
    .set({ check_requested_at: now })
    .where('id', '=', connectionId)
    .where('mode', '=', 'api')
    .where('status', 'in', WORKING_STATUSES)
    .where('token_ciphertext', 'is not', null)
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

/** Marks a requested check finished, whatever it found (also when it could not run). */
export async function finishHealthCheck(
  db: DbExecutor,
  connectionId: string,
  now: Date,
): Promise<void> {
  await db
    .updateTable('marketplace_connection')
    .set({ last_checked_at: now })
    .where('id', '=', connectionId)
    .where((eb) => eb.or([eb('last_checked_at', 'is', null), eb('last_checked_at', '<', now)]))
    .execute();
}

/** Whether a check the seller asked for is still running (and not given up on). */
export function checkPending(row: ConnectionRow, now: Date): boolean {
  const requested = row.check_requested_at;
  if (requested === null) return false;
  if (row.last_checked_at !== null && row.last_checked_at >= requested) return false;
  return now.getTime() - requested.getTime() < CHECK_PENDING_MS;
}
