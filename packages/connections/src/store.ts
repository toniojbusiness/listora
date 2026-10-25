/**
 * Reading and recording connection state (`marketplace_connection`). Status changes go through
 * `recordHealth`, so a connection's status, `last_ok_at`, and its latest problem always agree.
 */
import type { Selectable } from 'kysely';

import type {
  ConnectionStatus,
  DbExecutor,
  Marketplace,
  MarketplaceConnectionTable,
} from '@listora/db';

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
 * and moves `last_ok_at`; anything else records the problem. A revoked connection loses its
 * tokens, which are worthless. Only API connections that still hold their grant change: once
 * a connection needs the seller (reauth_required, revoked), only connecting again restores it.
 */
export async function recordHealth(
  db: DbExecutor,
  connectionId: string,
  update: HealthUpdate,
  now: Date,
): Promise<void> {
  let query = db
    .updateTable('marketplace_connection')
    .where('id', '=', connectionId)
    .where('mode', '=', 'api')
    .where('status', 'in', ['connected', 'degraded']);
  if (update.status === 'connected') {
    query = query.set({
      status: 'connected',
      last_ok_at: now,
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
      last_error: update.message,
      last_error_code: update.code,
      last_error_at: now,
      ...(update.status === 'revoked' ? { token_ciphertext: null } : {}),
    });
  }
  await query.execute();
}
