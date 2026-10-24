import { sql, type RawBuilder } from 'kysely';

import type { OperationRow } from './transitions.ts';

/**
 * Creation order of operations, compared inside Postgres: JavaScript dates hold milliseconds and
 * Postgres timestamps microseconds, so comparing with `op.created_at` would misorder operations
 * created within the same millisecond. Ties (one transaction) fall back to the uuidv7 id.
 * Use in a query on `marketplace_operation`.
 */
export function createdBefore(op: Pick<OperationRow, 'account_id' | 'id'>): RawBuilder<boolean> {
  return sql<boolean>`(created_at, id) < (${ownOrder(op)})`;
}

export function createdAfter(op: Pick<OperationRow, 'account_id' | 'id'>): RawBuilder<boolean> {
  return sql<boolean>`(created_at, id) > (${ownOrder(op)})`;
}

function ownOrder(op: Pick<OperationRow, 'account_id' | 'id'>): RawBuilder<unknown> {
  return sql`
    select own.created_at, own.id from marketplace_operation as own
    where own.account_id = ${op.account_id} and own.id = ${op.id}
  `;
}
