import { describe, expect, it } from 'vitest';

import { ConfigError, loadWorkerConfig } from './config.ts';

const DATABASE_URL = 'postgres://listora:hunter2@127.0.0.1:55432/listora';

describe('loadWorkerConfig', () => {
  it('applies defaults when only DATABASE_URL is set', () => {
    expect(loadWorkerConfig({ DATABASE_URL })).toEqual({
      databaseUrl: DATABASE_URL,
      logLevel: 'info',
      concurrency: 5,
      fakeMarketplaceUrl: undefined,
    });
  });

  it('reads explicit values', () => {
    expect(
      loadWorkerConfig({
        DATABASE_URL,
        LOG_LEVEL: 'debug',
        WORKER_CONCURRENCY: '12',
        FAKE_MARKETPLACE_URL: 'http://127.0.0.1:4100',
      }),
    ).toMatchObject({
      logLevel: 'debug',
      concurrency: 12,
      fakeMarketplaceUrl: 'http://127.0.0.1:4100',
    });
  });

  it('reports every invalid key at once', () => {
    expect(
      captureConfigError({
        LOG_LEVEL: 'loud',
        WORKER_CONCURRENCY: '0',
        FAKE_MARKETPLACE_URL: 'ftp://fake',
      }).issues,
    ).toEqual([
      'DATABASE_URL is required',
      'LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent',
      'WORKER_CONCURRENCY must be an integer from 1 to 100',
      'FAKE_MARKETPLACE_URL must be an http:// or https:// URL',
    ]);
  });

  it.each(['five', '1.5', '-2', '101', ''])('rejects WORKER_CONCURRENCY=%j', (value) => {
    expect(captureConfigError({ DATABASE_URL, WORKER_CONCURRENCY: value }).issues).toEqual([
      'WORKER_CONCURRENCY must be an integer from 1 to 100',
    ]);
  });

  it('rejects a non-postgres DATABASE_URL without echoing its value', () => {
    const error = captureConfigError({ DATABASE_URL: 'mysql://root:hunter2@db/x' });
    expect(error.issues).toEqual(['DATABASE_URL must be a postgres:// URL']);
    expect(error.message).not.toContain('hunter2');
  });
});

function captureConfigError(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadWorkerConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected loadWorkerConfig to throw');
}
