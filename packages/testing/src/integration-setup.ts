import { existsSync } from 'node:fs';

import pg from 'pg';

import { testDatabaseUrl } from './database-url.ts';

/**
 * Vitest global setup for the `integration` project: loads `.env` when present (existing
 * environment variables win), then fails fast with a fix hint if Postgres is unreachable.
 * Integration tests never skip silently; a missing database is a failed check.
 */
export default async function setup(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');

  const url = testDatabaseUrl();
  process.env['TEST_DATABASE_URL'] = url;

  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query('select 1');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const message =
      `Integration tests need Postgres at ${redactPassword(url)} (${reason}).\n` +
      'Start the local cluster with `scripts/dev-db.sh start`, or set TEST_DATABASE_URL.';
    const failure = new Error(message);
    // Report only the message: Vitest 5 crashes while source-mapping global-setup stack frames,
    // which would hide this hint behind an unrelated TypeError.
    failure.stack = message;
    throw failure;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function redactPassword(url: string): string {
  return url.replace(/(\/\/[^:/@]+:)[^@]*@/, '$1[redacted]@');
}
