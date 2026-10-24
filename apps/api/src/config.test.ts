import { loadAiConfig } from '@listora/ai';
import { DEFAULT_LOCAL_STORAGE_BASE_URL, DEFAULT_LOCAL_STORAGE_DIR } from '@listora/storage';
import { describe, expect, it } from 'vitest';

import { ConfigError, loadApiConfig } from './config.ts';

const DATABASE_URL = 'postgres://listora:hunter2@127.0.0.1:55432/listora';
const REQUIRED = { DATABASE_URL, AUTH_DRIVER: 'dev' };

describe('loadApiConfig', () => {
  it('applies defaults when only the required keys are set', () => {
    expect(loadApiConfig(REQUIRED)).toEqual({
      host: '127.0.0.1',
      port: 3000,
      databaseUrl: DATABASE_URL,
      logLevel: 'info',
      auth: { driver: 'dev', devSecret: undefined },
      storage: {
        driver: 'local',
        rootDir: DEFAULT_LOCAL_STORAGE_DIR,
        baseUrl: DEFAULT_LOCAL_STORAGE_BASE_URL,
        signingSecret: undefined,
      },
      ai: loadAiConfig({}),
    });
  });

  it('reads explicit values', () => {
    expect(
      loadApiConfig({
        ...REQUIRED,
        API_HOST: '0.0.0.0',
        API_PORT: '0',
        LOG_LEVEL: 'debug',
        AUTH_DEV_SECRET: 'x'.repeat(32),
      }),
    ).toMatchObject({
      host: '0.0.0.0',
      port: 0,
      logLevel: 'debug',
      auth: { driver: 'dev', devSecret: 'x'.repeat(32) },
    });
  });

  it('reports every invalid key at once', () => {
    const error = captureConfigError({ API_PORT: '70000', LOG_LEVEL: 'loud' });
    expect(error.issues).toEqual([
      'API_PORT must be an integer from 0 to 65535',
      'AUTH_DRIVER is required',
      'DATABASE_URL is required',
      'LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent',
    ]);
  });

  it('reports storage problems together with the API ones', () => {
    const error = captureConfigError({ API_PORT: 'x', STORAGE_DRIVER: 's3' });
    expect(error.issues).toEqual([
      'API_PORT must be an integer from 0 to 65535',
      'AUTH_DRIVER is required',
      'DATABASE_URL is required',
      'STORAGE_S3_BUCKET must be an S3 bucket name',
      'STORAGE_S3_REGION must be an AWS region such as us-east-1',
      'STORAGE_PUBLIC_BASE_URL must be an http(s) URL when STORAGE_DRIVER is s3',
    ]);
  });

  it('reports AI problems together with the API ones, without echoing the API key', () => {
    const error = captureConfigError({
      API_PORT: 'x',
      AI_PROVIDER: 'anthropic',
      AI_KILL_SWITCH: 'maybe',
    });
    expect(error.issues).toEqual([
      'API_PORT must be an integer from 0 to 65535',
      'AUTH_DRIVER is required',
      'DATABASE_URL is required',
      'ANTHROPIC_API_KEY is required when AI_PROVIDER is anthropic',
      'AI_KILL_SWITCH must be on or off',
    ]);
    const keyed = captureConfigError({
      ...REQUIRED,
      ANTHROPIC_API_KEY: 'sk-secret',
      AI_PROVIDER: 'x',
    });
    expect(keyed.message).not.toContain('sk-secret');
  });

  it.each(['3000abc', '-1', '1.5', ''])('rejects API_PORT=%j', (API_PORT) => {
    expect(captureConfigError({ ...REQUIRED, API_PORT }).issues).toEqual([
      'API_PORT must be an integer from 0 to 65535',
    ]);
  });

  it('rejects a non-postgres DATABASE_URL without echoing its value', () => {
    const error = captureConfigError({ ...REQUIRED, DATABASE_URL: 'mysql://root:hunter2@db/x' });
    expect(error.issues).toEqual(['DATABASE_URL must be a postgres:// URL']);
    expect(error.message).not.toContain('hunter2');
  });

  it('rejects an empty DATABASE_URL', () => {
    expect(captureConfigError({ ...REQUIRED, DATABASE_URL: '' }).issues).toEqual([
      'DATABASE_URL is required',
    ]);
  });

  it('rejects an auth driver this build does not have', () => {
    expect(captureConfigError({ ...REQUIRED, AUTH_DRIVER: 'cognito' }).issues).toEqual([
      'AUTH_DRIVER must be one of dev',
    ]);
  });

  it('rejects a short AUTH_DEV_SECRET without echoing it', () => {
    const error = captureConfigError({ ...REQUIRED, AUTH_DEV_SECRET: 'tooshort-secret' });
    expect(error.issues).toEqual(['AUTH_DEV_SECRET must be at least 32 characters']);
    expect(error.message).not.toContain('tooshort-secret');
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
