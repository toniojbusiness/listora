/**
 * Resolves the Postgres URL integration tests use. CI sets TEST_DATABASE_URL to its service
 * container; locally it defaults to the `listora_test` database of the cluster started by
 * `scripts/dev-db.sh`, whose port defaults to 55432 (keep in sync with that script).
 */
export function testDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['TEST_DATABASE_URL'];
  if (explicit !== undefined && explicit !== '') return explicit;
  const port = env['LISTORA_PG_PORT'] ?? '55432';
  return `postgres://listora@127.0.0.1:${port}/listora_test`;
}
