import { loadAiConfig } from '@listora/ai';
import { loadAutomationSettings } from '@listora/automation';
import { loadEmailIngestConfig } from '@listora/email-sales';
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
      databaseConnectTimeoutMs: 5_000,
      logLevel: 'info',
      auth: { driver: 'dev', devSecret: undefined },
      signUp: { mode: 'open' },
      inviteEmailVerification: 'none',
      storage: {
        driver: 'local',
        rootDir: DEFAULT_LOCAL_STORAGE_DIR,
        baseUrl: DEFAULT_LOCAL_STORAGE_BASE_URL,
        signingSecret: undefined,
      },
      ai: loadAiConfig({}),
      marketplaces: {
        fakeMarketplaceUrl: undefined,
        ebay: undefined,
        depop: undefined,
        tokenVault: undefined,
        features: 'verified',
      },
      automation: loadAutomationSettings({}),
      emailIngest: loadEmailIngestConfig({}),
      operationRetryDelayScale: 1,
    });
  });

  it('reads who may sign up, and how invitees are reached', () => {
    const cognito = {
      ...REQUIRED,
      AUTH_DRIVER: 'cognito',
      COGNITO_USER_POOL_ID: 'us-east-1_AbC123xyZ',
      COGNITO_CLIENT_IDS: 'client1',
    };
    expect(
      loadApiConfig({
        ...cognito,
        SIGN_UP: 'invite',
        SIGN_UP_OWNER_EMAIL: 'Owner@Example.com',
        INVITE_EMAIL_VERIFICATION: 'ses',
      }),
    ).toMatchObject({
      signUp: { mode: 'invite', ownerEmail: 'owner@example.com' },
      inviteEmailVerification: 'ses',
    });
    expect(loadApiConfig({ ...REQUIRED, SIGN_UP: 'invite' }).signUp).toEqual({
      mode: 'invite',
      ownerEmail: undefined,
    });
    for (const [env, problem] of [
      [{ SIGN_UP: 'closed' }, 'SIGN_UP must be one of open, invite'],
      [{ SIGN_UP: 'invite', SIGN_UP_OWNER_EMAIL: 'nobody' }, 'SIGN_UP_OWNER_EMAIL must be'],
      [
        { SIGN_UP_OWNER_EMAIL: 'owner@example.com' },
        'SIGN_UP_OWNER_EMAIL is only for SIGN_UP=invite',
      ],
      [
        { INVITE_EMAIL_VERIFICATION: 'ses' },
        'INVITE_EMAIL_VERIFICATION=ses needs AUTH_DRIVER=cognito',
      ],
      [{ INVITE_EMAIL_VERIFICATION: 'smtp' }, 'INVITE_EMAIL_VERIFICATION must be one of none, ses'],
    ] as const) {
      expect(() => loadApiConfig({ ...REQUIRED, ...env }), problem).toThrow(problem);
    }
  });

  it('reads the automation settings, refusing a fake site on a real marketplace', () => {
    expect(
      loadApiConfig({ ...REQUIRED, FAKE_AUTOMATION_SITE_URL: 'http://127.0.0.1:4300' }),
    ).toMatchObject({
      automation: { profiles: { poshmark: { loginUrl: 'http://127.0.0.1:4300/login' } } },
    });
    expect(() =>
      loadApiConfig({ ...REQUIRED, FAKE_AUTOMATION_SITE_URL: 'https://poshmark.com' }),
    ).toThrow('FAKE_AUTOMATION_SITE_URL');
  });

  it('reads the eBay keyset and the token vault, without echoing a secret', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    expect(
      loadApiConfig({
        ...REQUIRED,
        EBAY_ENV: 'fake',
        EBAY_FAKE_URL: 'http://127.0.0.1:4110',
        TOKEN_ENCRYPTION_KEY: key,
      }).marketplaces,
    ).toMatchObject({ ebay: { environment: 'fake' }, tokenVault: { driver: 'local' } });
    const error = captureConfigError({
      ...REQUIRED,
      EBAY_ENV: 'production',
      EBAY_CLIENT_SECRET: 'very-secret',
      TOKEN_KMS_KEY_ID: 'not a key',
    });
    expect(error.issues).toEqual([
      'EBAY_CLIENT_ID is required when EBAY_ENV is production',
      'TOKEN_KMS_KEY_ID must be a KMS key ARN, key id, or alias/<name>',
    ]);
    expect(String(error)).not.toContain('very-secret');
  });

  it('reads explicit values', () => {
    expect(
      loadApiConfig({
        ...REQUIRED,
        API_HOST: '0.0.0.0',
        API_PORT: '0',
        DATABASE_CONNECT_TIMEOUT_MS: '30000',
        LOG_LEVEL: 'debug',
        AUTH_DEV_SECRET: 'x'.repeat(32),
      }),
    ).toMatchObject({
      host: '0.0.0.0',
      port: 0,
      databaseConnectTimeoutMs: 30_000,
      logLevel: 'debug',
      auth: { driver: 'dev', devSecret: 'x'.repeat(32) },
    });
  });

  it('reports every invalid key at once', () => {
    const error = captureConfigError({
      API_PORT: '70000',
      DATABASE_CONNECT_TIMEOUT_MS: '5s',
      LOG_LEVEL: 'loud',
    });
    expect(error.issues).toEqual([
      'API_PORT must be an integer from 0 to 65535',
      'AUTH_DRIVER is required',
      'DATABASE_URL is required',
      'DATABASE_CONNECT_TIMEOUT_MS must be an integer from 100 to 120000 (milliseconds)',
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
    expect(captureConfigError({ ...REQUIRED, AUTH_DRIVER: 'clerk' }).issues).toEqual([
      'AUTH_DRIVER must be one of dev, cognito',
    ]);
  });

  describe('AUTH_DRIVER=cognito', () => {
    const COGNITO = {
      ...REQUIRED,
      AUTH_DRIVER: 'cognito',
      COGNITO_USER_POOL_ID: 'us-east-1_AbC123xyZ',
      COGNITO_CLIENT_IDS: '4abc123def456ghi789jkl0mno, 5pqr678stu',
    };

    it('reads the pool, its region, and the accepted app clients', () => {
      expect(loadApiConfig(COGNITO).auth).toEqual({
        driver: 'cognito',
        cognito: {
          region: 'us-east-1',
          userPoolId: 'us-east-1_AbC123xyZ',
          clientIds: ['4abc123def456ghi789jkl0mno', '5pqr678stu'],
        },
      });
      expect(
        loadApiConfig({ ...COGNITO, COGNITO_USER_POOL_ID: 'ap-southeast-2_Xy9' }).auth,
      ).toMatchObject({ cognito: { region: 'ap-southeast-2' } });
    });

    it('requires the pool and the app clients', () => {
      expect(captureConfigError({ ...REQUIRED, AUTH_DRIVER: 'cognito' }).issues).toEqual([
        'COGNITO_USER_POOL_ID is required when AUTH_DRIVER=cognito',
        'COGNITO_CLIENT_IDS is required when AUTH_DRIVER=cognito',
      ]);
    });

    it.each(['us-east-1', 'useast1_abc', 'us-east-1_', 'us-east-1_abc/../x', 'US-EAST-1_abc'])(
      'rejects COGNITO_USER_POOL_ID=%j',
      (COGNITO_USER_POOL_ID) => {
        expect(captureConfigError({ ...COGNITO, COGNITO_USER_POOL_ID }).issues).toEqual([
          'COGNITO_USER_POOL_ID must be a user pool id such as us-east-1_AbC123xyZ',
        ]);
      },
    );

    it.each(['', 'abc,', 'abc def', 'abc,../x'])('rejects COGNITO_CLIENT_IDS=%j', (ids) => {
      expect(captureConfigError({ ...COGNITO, COGNITO_CLIENT_IDS: ids }).issues).toEqual([
        'COGNITO_CLIENT_IDS must be a comma-separated list of app client ids',
      ]);
    });

    it('ignores the Cognito keys under the dev driver', () => {
      expect(loadApiConfig({ ...COGNITO, AUTH_DRIVER: 'dev' }).auth).toEqual({
        driver: 'dev',
        devSecret: undefined,
      });
    });
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
