import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';

import type { Database } from './schema.ts';

export type Db = Kysely<Database>;
/** The node-postgres pool behind a `Db`, for callers that need driver features (query timeouts). */
export type DatabasePool = pg.Pool;
export type DbTransaction = Transaction<Database>;
/** Either a database handle or an open transaction. */
export type DbExecutor = Db | DbTransaction;

export interface DatabaseOptions {
  connectionString: string;
  /** Fail fast instead of hanging when Postgres is unreachable. */
  connectionTimeoutMillis?: number;
  max?: number;
}

/**
 * Value parsers for this pool only (the global `pg.types` registry is left alone):
 * - `bigint` (money in cents, counters, `count(*)`) parses to a number and throws rather than
 *   silently losing precision above Number.MAX_SAFE_INTEGER.
 * - `date` stays a `YYYY-MM-DD` string; the default parser builds a local-time Date, which
 *   shifts the day in timezones west of UTC.
 */
const typeParsers: pg.CustomTypesConfig = {
  getTypeParser: (oid, format) => {
    if (format !== 'binary') {
      if (oid === pg.types.builtins.INT8) return parseSafeInteger;
      if (oid === pg.types.builtins.DATE) return (value: string) => value;
    }
    return pg.types.getTypeParser(oid, format) as (value: string) => unknown;
  },
};

export function parseSafeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`bigint value ${value} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return parsed;
}

/** Creates a connection pool with Listora's value parsers (see `typeParsers` above). */
export function createPool(options: DatabaseOptions): DatabasePool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    max: options.max ?? 10,
    types: typeParsers,
  });
  // An idle client can error when the server restarts; without a listener that crashes the
  // process. The next query gets a fresh connection.
  pool.on('error', () => undefined);
  return pool;
}

/**
 * Creates the typed Kysely handle every backend process uses, on a new pool or on one from
 * `createPool`. Call `destroy()` on shutdown; it also ends the pool.
 */
export function createDatabase(source: DatabaseOptions | DatabasePool): Db {
  const pool = source instanceof pg.Pool ? source : createPool(source);
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** Runs `work` in `executor` when it is already a transaction, otherwise in a new one. */
export async function inTransaction<T>(
  executor: DbExecutor,
  work: (trx: DbTransaction) => Promise<T>,
): Promise<T> {
  if (executor.isTransaction) return work(executor as DbTransaction);
  return executor.transaction().execute(work);
}
