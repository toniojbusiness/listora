/**
 * Counts the SQL statements this process sends, on every pooled connection, for the latency
 * benchmark and the query-count tests (docs/features/performance.md). Installing it wraps
 * `pg.Client.prototype.query` once; it is for benchmarks and tests, never for the API itself.
 */
import pg from 'pg';

let installed = false;
let count = 0;

/** Starts counting (idempotent) and returns a reader of the running total. */
export function countStatements(): () => number {
  if (!installed) {
    installed = true;
    const prototype = pg.Client.prototype as unknown as {
      query: (this: pg.Client, ...args: unknown[]) => unknown;
    };
    const original = prototype.query;
    prototype.query = function countedQuery(this: pg.Client, ...args: unknown[]) {
      count += 1;
      return original.apply(this, args);
    };
  }
  return () => count;
}
