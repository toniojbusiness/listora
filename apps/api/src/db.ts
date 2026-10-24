import type { DatabasePool } from '@listora/db';
import type pg from 'pg';

/**
 * Round-trips a trivial query; rejects if the database cannot be reached or does not answer
 * within `queryTimeoutMillis`.
 */
export async function pingDatabase(pool: DatabasePool, queryTimeoutMillis = 2_000): Promise<void> {
  // node-postgres honours a per-query `query_timeout`, but @types/pg does not declare it.
  const ping: pg.QueryConfig & { query_timeout: number } = {
    text: 'select 1',
    query_timeout: queryTimeoutMillis,
  };
  await pool.query(ping);
}
