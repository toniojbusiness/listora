import { describe, expect, it } from 'vitest';

import { ConfigError, loadApiConfig } from './config.ts';

const DATABASE_URL = 'postgres://listora:hunter2@127.0.0.1:55432/listora';

describe('loadApiConfig', () => {
  it('applies defaults when only DATABASE_URL is set', () => {
    expect(loadApiConfig({ DATABASE_URL })).toEqual({
      host: '127.0.0.1',
      port: 3000,
      databaseUrl: DATABASE_URL,
      logLevel: 'info',
    });
  });

  it('reads explicit values', () => {
    expect(
      loadApiConfig({ DATABASE_URL, API_HOST: '0.0.0.0', API_PORT: '0', LOG_LEVEL: 'debug' }),
    ).toMatchObject({ host: '0.0.0.0', port: 0, logLevel: 'debug' });
  });

  it('reports every invalid key at once', () => {
    const error = captureConfigError({ API_PORT: '70000', LOG_LEVEL: 'loud' });
    expect(error.issues).toEqual([
      'API_PORT must be an integer from 0 to 65535',
      'DATABASE_URL is required',
      'LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent',
    ]);
  });

  it.each(['3000abc', '-1', '1.5', ''])('rejects API_PORT=%j', (API_PORT) => {
    expect(captureConfigError({ DATABASE_URL, API_PORT }).issues).toEqual([
      'API_PORT must be an integer from 0 to 65535',
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
    loadApiConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected loadApiConfig to throw');
}
