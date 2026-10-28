/**
 * Read-only connections (docs/features/read-only.md). A seller can mark a marketplace connection
 * read only: Listora still reads the account, but never changes anything on it. Every write path
 * checks it here: queueing an operation (`enqueueOperation`, `retryOperation`), the engine's step
 * before it sends (executor.ts), and automatic work, which skips such a listing and queues
 * nothing (the delists after a sale, `@listora/auto-delist`). The browser runner, the phone's
 * dispatch, and the phone runtime refuse write scripts on it too (`@listora/automation`).
 *
 * A listing is read only when its connection is, and a listing without a connection when the
 * account's connection on its marketplace is: the account holds one connection per marketplace,
 * so that is the only account on the marketplace Listora could be asked to change.
 */
import { sql, type RawBuilder } from 'kysely';

import { inTransaction, type DbExecutor, type Marketplace, type OperationKind } from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';

import { removeOperationJob } from './jobs.ts';
import { removePhoneWork } from './phone-queue.ts';
import { transitionOperation } from './transitions.ts';

/**
 * The operation kinds that only read the marketplace. Every other kind, including any kind added
 * later, changes it and is refused on a read-only connection.
 */
const READ_KINDS: readonly OperationKind[] = ['verify'];

/** Whether an operation of this kind may change the marketplace. */
export function isWriteKind(kind: OperationKind): boolean {
  return !READ_KINDS.includes(kind);
}

/** The error code of a change refused because its connection is read only. */
export const READ_ONLY_ERROR = 'connection_read_only';

/** What the seller is told when a change is refused on a read-only connection. */
export function readOnlyMessage(marketplace: Marketplace): string {
  const name = MARKETPLACE_NAMES[marketplace];
  return `Your ${name} account is read only, so Listora won't change anything on it. To let Listora change it, turn off Read only for ${name} in Link accounts.`;
}

/** A change was asked for on a listing whose connection is read only; nothing was queued. */
export class ReadOnlyConnectionError extends Error {
  readonly marketplace: Marketplace;

  constructor(marketplace: Marketplace) {
    super(readOnlyMessage(marketplace));
    this.name = 'ReadOnlyConnectionError';
    this.marketplace = marketplace;
  }
}

/**
 * Whether the listing `alias` names (a `marketplace_listing` in the query) is read only, as a SQL
 * expression for queries that read many listings.
 */
export function listingIsReadOnly(alias: string): RawBuilder<boolean> {
  const listing = (column: string) => sql.ref(`${alias}.${column}`);
  return sql<boolean>`exists (
    select 1 from marketplace_connection as read_only_connection
    where read_only_connection.account_id = ${listing('account_id')}
      and read_only_connection.read_only
      and (
        read_only_connection.id = ${listing('connection_id')}
        or (
          ${listing('connection_id')} is null
          and read_only_connection.marketplace = ${listing('marketplace')}
        )
      )
  )`;
}

/** The listing's marketplace and whether it is read only; `undefined` when there is no listing. */
export async function readOnlyListing(
  db: DbExecutor,
  target: { accountId: string; listingId: string },
): Promise<{ marketplace: Marketplace; readOnly: boolean } | undefined> {
  const row = await db
    .selectFrom('marketplace_listing as listing')
    .select(['listing.marketplace', listingIsReadOnly('listing').as('read_only')])
    .where('listing.account_id', '=', target.accountId)
    .where('listing.id', '=', target.listingId)
    .executeTakeFirst();
  return row === undefined ? undefined : { marketplace: row.marketplace, readOnly: row.read_only };
}

/** Throws `ReadOnlyConnectionError` when an operation of `kind` would change a read-only listing. */
export async function assertWritableListing(
  db: DbExecutor,
  target: { accountId: string; listingId: string; kind: OperationKind },
): Promise<void> {
  if (!isWriteKind(target.kind)) return;
  const listing = await readOnlyListing(db, target);
  if (listing?.readOnly === true) throw new ReadOnlyConnectionError(listing.marketplace);
}

/**
 * Turns the connection's read-only flag on or off (the seller's choice in Link accounts). Turning
 * it on also fails every change still waiting to be sent to its listings (queued, or waiting to
 * retry) with the read-only error, so the seller sees at once that it won't happen; a step under
 * way finishes its read-back, and the engine sends nothing after it. Returns the connection's
 * marketplace and the failed operations' ids, oldest first, or `undefined` when the account has
 * no such connection.
 */
export async function setConnectionReadOnly(
  executor: DbExecutor,
  target: { accountId: string; connectionId: string },
  readOnly: boolean,
): Promise<{ marketplace: Marketplace; refused: string[] } | undefined> {
  return inTransaction(executor, async (trx) => {
    const connection = await trx
      .updateTable('marketplace_connection')
      .set({ read_only: readOnly })
      .where('account_id', '=', target.accountId)
      .where('id', '=', target.connectionId)
      .returning(['marketplace'])
      .executeTakeFirst();
    if (connection === undefined) return undefined;
    if (!readOnly) return { marketplace: connection.marketplace, refused: [] };

    const waiting = await trx
      .selectFrom('marketplace_operation as op')
      .innerJoin('marketplace_listing as listing', (join) =>
        join
          .onRef('listing.account_id', '=', 'op.account_id')
          .onRef('listing.id', '=', 'op.listing_id'),
      )
      .selectAll('op')
      .where('op.account_id', '=', target.accountId)
      .where('op.status', 'in', ['queued', 'retrying'])
      .where('op.kind', 'not in', READ_KINDS)
      .where(listingIsReadOnly('listing'))
      .orderBy('op.created_at')
      .orderBy('op.id')
      .forUpdate('op')
      .execute();
    const refused: string[] = [];
    for (const op of waiting) {
      await transitionOperation(
        trx,
        op,
        {
          to: 'failed',
          error: { code: READ_ONLY_ERROR, message: readOnlyMessage(connection.marketplace) },
        },
        { action: 'read_only' },
      );
      await removeOperationJob(trx, op.id);
      await removePhoneWork(trx, op);
      refused.push(op.id);
    }
    return { marketplace: connection.marketplace, refused };
  });
}
