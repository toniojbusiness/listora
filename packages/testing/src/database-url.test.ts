import { describe, expect, it } from 'vitest';

import { testDatabaseUrl } from './database-url.ts';

describe('testDatabaseUrl', () => {
  it('prefers TEST_DATABASE_URL', () => {
    expect(testDatabaseUrl({ TEST_DATABASE_URL: 'postgres://ci@db:5432/x' })).toBe(
      'postgres://ci@db:5432/x',
    );
  });

  it('defaults to the dev-db.sh cluster port', () => {
    expect(testDatabaseUrl({})).toBe('postgres://listora@127.0.0.1:55432/listora_test');
  });

  it('follows LISTORA_PG_PORT', () => {
    expect(testDatabaseUrl({ LISTORA_PG_PORT: '56000' })).toBe(
      'postgres://listora@127.0.0.1:56000/listora_test',
    );
  });
});
