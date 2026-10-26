/**
 * Completion records of deletions (docs/features/privacy.md). Every deletion job (an account,
 * a marketplace connection, an eBay user's data) writes one when it has checked that nothing it
 * was meant to delete remains. A record holds no personal data: no account, user, or
 * marketplace user id, no email address, no name.
 */
import { sql } from 'kysely';

import type { DbExecutor } from './database.ts';
import { jsonb, type JsonObject } from './json.ts';
import type { DeletionRecordKind, Marketplace } from './values.ts';

/**
 * Every deletion finishes within this bound: the 7 days its job keeps asking a marketplace to
 * revoke a grant, plus a day. A tombstone older than this is overdue; its job logs an error on
 * every run, and the trust metrics count it (`OverdueDeletions`), which an alarm keys on.
 */
export const DELETION_COMPLETION_DEADLINE_MS = 8 * 86_400_000;

export interface DeletionRecord {
  /** The deletion's id: its tombstone's, or a new one where there is no tombstone. */
  id: string;
  kind: DeletionRecordKind;
  /** Why it was deleted (`user_request`, `unlinked`, ...). */
  reason: string;
  marketplace?: Marketplace;
  requestedAt: Date;
  /** Counts and outcomes only. */
  summary: JsonObject;
}

/** Writes the record; a repeat for the same deletion (a crash after writing it) keeps the first. */
export async function recordDeletion(executor: DbExecutor, record: DeletionRecord): Promise<void> {
  await executor
    .insertInto('deletion_record')
    .values({
      id: record.id,
      kind: record.kind,
      reason: record.reason,
      marketplace: record.marketplace ?? null,
      requested_at: record.requestedAt,
      summary: jsonb(record.summary),
    })
    .onConflict((conflict) => conflict.column('id').doNothing())
    .execute();
}

/**
 * The rows that still reference `references`: for every single-column foreign key to `table`'s
 * primary key, the number of rows whose column holds `id` (and `table`'s own row). It reads the
 * foreign keys from the catalog, so a table added later is checked without a change here.
 * Columns listed in `except` (`table.column`) are skipped.
 */
export async function rowsReferencing(
  executor: DbExecutor,
  table: 'account' | 'app_user',
  id: string,
  except: readonly string[] = [],
): Promise<Record<string, number>> {
  const { rows: columns } = await sql<{ table_name: string; column_name: string }>`
    select fk.conrelid::regclass::text as table_name, attribute.attname as column_name
    from pg_constraint as fk
    join pg_attribute as attribute
      on attribute.attrelid = fk.conrelid and attribute.attnum = fk.conkey[1]
    where fk.contype = 'f' and fk.confrelid = ${table}::regclass
      and cardinality(fk.conkey) = 1
    order by 1, 2
  `.execute(executor);
  const found: Record<string, number> = {};
  const count = async (tableName: string, column: string): Promise<void> => {
    const { rows } = await sql<{ count: number }>`
      select count(*)::int as count from ${sql.table(tableName)}
      where ${sql.ref(column)} = ${id}::uuid
    `.execute(executor);
    const value = rows[0]?.count ?? 0;
    if (value > 0) found[`${tableName}.${column}`] = value;
  };
  await count(table, 'id');
  for (const { table_name: tableName, column_name: column } of columns) {
    if (except.includes(`${tableName}.${column}`)) continue;
    await count(tableName, column);
  }
  return found;
}
