import { describe, expect, it } from 'vitest';

import { ConfigError, loadMigrateConfig } from './config.ts';

const env = { DATABASE_URL: 'postgres://listora@127.0.0.1:55432/listora' };

function issuesOf(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('loadMigrateConfig', () => {
  it('defaults to migrating to the latest version', () => {
    expect(loadMigrateConfig([], env)).toEqual({
      command: 'latest',
      target: undefined,
      databaseUrl: env.DATABASE_URL,
      logLevel: 'info',
    });
  });

  it('accepts down with the name of the migration to revert', () => {
    expect(loadMigrateConfig(['down', '0001_schema_v1'], env)).toMatchObject({
      command: 'down',
      target: '0001_schema_v1',
    });
  });

  it('requires a migration name for down', () => {
    expect(issuesOf(() => loadMigrateConfig(['down'], env))).toEqual([
      expect.stringContaining('down reverts one migration and needs its name'),
    ]);
  });

  it('rejects unknown commands and stray arguments', () => {
    expect(issuesOf(() => loadMigrateConfig(['drop'], env))).toEqual([
      expect.stringContaining('unknown command drop'),
    ]);
    expect(issuesOf(() => loadMigrateConfig(['latest', 'extra'], env))).toEqual([
      expect.stringContaining('unexpected arguments'),
    ]);
  });

  it('requires a postgres DATABASE_URL and never echoes its value', () => {
    expect(issuesOf(() => loadMigrateConfig([], {}))).toEqual(['DATABASE_URL is required']);
    const issues = issuesOf(() =>
      loadMigrateConfig([], { DATABASE_URL: 'mysql://u:hunter2-secret@db/x' }),
    );
    expect(issues).toEqual(['DATABASE_URL must be a postgres:// URL']);
    expect(issues.join('\n')).not.toContain('hunter2-secret');
  });

  it('validates LOG_LEVEL', () => {
    expect(issuesOf(() => loadMigrateConfig([], { ...env, LOG_LEVEL: 'loud' }))).toEqual([
      expect.stringContaining('LOG_LEVEL must be one of'),
    ]);
  });
});
