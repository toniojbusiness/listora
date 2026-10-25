import { describe, expect, it } from 'vitest';

import { ConfigError, loadAdminConfig } from './config.ts';

describe('loadAdminConfig', () => {
  it('reads the database URL and log level', () => {
    expect(loadAdminConfig({ DATABASE_URL: 'postgres://listora@127.0.0.1:55432/listora' })).toEqual(
      {
        databaseUrl: 'postgres://listora@127.0.0.1:55432/listora',
        logLevel: 'info',
      },
    );
  });

  it('names every bad key without echoing a value', () => {
    let error: unknown;
    try {
      loadAdminConfig({ DATABASE_URL: 'mysql://root:secret@db', LOG_LEVEL: 'loud' });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues).toEqual([
      'DATABASE_URL must be a postgres:// URL',
      'LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent',
    ]);
    expect((error as ConfigError).message).not.toContain('secret');
  });
});
