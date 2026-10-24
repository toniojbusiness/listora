import pg from 'pg';

export type DatabasePool = pg.Pool;

export interface DatabaseOptions {
  connectionString: string;
  /** Fail fast instead of hanging when Postgres is unreachable. */
  connectionTimeoutMillis?: number;
  max?: number;
}

export function createDatabasePool(options: DatabaseOptions): DatabasePool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    max: options.max ?? 10,
  });
  // An idle client can error when the server restarts; without a listener that crashes the
  // process. The next query gets a fresh connection, so logging upstream is enough.
  pool.on('error', () => undefined);
  return pool;
}

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
