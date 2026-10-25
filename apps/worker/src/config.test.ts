import { describe, expect, it } from 'vitest';

import { DEFAULT_FAKE_FIXTURES_DIR } from '@listora/ai';

import { ConfigError, loadWorkerConfig } from './config.ts';

const DATABASE_URL = 'postgres://listora:hunter2@127.0.0.1:55432/listora';

describe('loadWorkerConfig', () => {
  it('applies defaults when only DATABASE_URL is set', () => {
    expect(loadWorkerConfig({ DATABASE_URL })).toMatchObject({
      databaseUrl: DATABASE_URL,
      logLevel: 'info',
      concurrency: 5,
      taskConcurrency: 2,
      operationRetryDelayScale: 1,
      marketplaces: {
        fakeMarketplaceUrl: undefined,
        ebay: undefined,
        depop: undefined,
        tokenVault: undefined,
      },
      cognitoUserPool: undefined,
      storage: { driver: 'local' },
      ai: { provider: 'fake', fakeFixturesDir: DEFAULT_FAKE_FIXTURES_DIR },
      analysis: { autoEscalate: true },
      aiAlerts: {
        dailyBudgetMicros: 1_000_000,
        globalDailyAlertMicros: 25_000_000,
        warnPercent: 80,
      },
    });
  });

  it('reads the storage, AI, and analysis settings the jobs need', () => {
    expect(
      loadWorkerConfig({
        DATABASE_URL,
        STORAGE_LOCAL_DIR: '/tmp/listora-storage',
        AI_FAKE_FIXTURES_DIR: '/tmp/listora-fixtures',
        AI_AUTO_ESCALATE: 'off',
      }),
    ).toMatchObject({
      storage: { driver: 'local', rootDir: '/tmp/listora-storage' },
      ai: { fakeFixturesDir: '/tmp/listora-fixtures' },
      analysis: { autoEscalate: false },
    });
  });

  it('reads explicit values', () => {
    expect(
      loadWorkerConfig({
        DATABASE_URL,
        LOG_LEVEL: 'debug',
        WORKER_CONCURRENCY: '12',
        WORKER_TASK_CONCURRENCY: '3',
        OPERATION_RETRY_DELAY_SCALE: '0.1',
        FAKE_MARKETPLACE_URL: 'http://127.0.0.1:4100',
        COGNITO_USER_POOL_ID: 'eu-west-2_AbC123xyZ',
      }),
    ).toMatchObject({
      logLevel: 'debug',
      concurrency: 12,
      taskConcurrency: 3,
      operationRetryDelayScale: 0.1,
      marketplaces: { fakeMarketplaceUrl: 'http://127.0.0.1:4100' },
      cognitoUserPool: { region: 'eu-west-2', userPoolId: 'eu-west-2_AbC123xyZ' },
    });
  });

  it('reads the AI spend check thresholds', () => {
    expect(
      loadWorkerConfig({
        DATABASE_URL,
        AI_DAILY_BUDGET_USD: '2.50',
        AI_GLOBAL_DAILY_ALERT_USD: '40',
        AI_ALERT_WARN_PERCENT: '90',
      }).aiAlerts,
    ).toEqual({
      dailyBudgetMicros: 2_500_000,
      globalDailyAlertMicros: 40_000_000,
      warnPercent: 90,
    });
  });

  it('reports invalid AI alert keys with the others', () => {
    expect(
      captureConfigError({
        LOG_LEVEL: 'loud',
        AI_GLOBAL_DAILY_ALERT_USD: '0',
        AI_ALERT_WARN_PERCENT: '101',
      }).issues,
    ).toEqual([
      'DATABASE_URL is required',
      'LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent',
      'AI_GLOBAL_DAILY_ALERT_USD must be a dollar amount above zero such as 25.00',
      'AI_ALERT_WARN_PERCENT must be an integer from 1 to 100',
    ]);
  });

  it('reads the browser automation settings and how to start the browser runner', () => {
    const config = loadWorkerConfig({
      DATABASE_URL,
      FAKE_AUTOMATION_SITE_URL: 'http://127.0.0.1:4400',
      AUTOMATION_MERCARI_RUNS_PER_HOUR: '12',
      BROWSER_RUNNER_LAUNCH: 'ecs',
      BROWSER_RUNNER_CLUSTER: 'listora-personal',
      BROWSER_RUNNER_SERVICE: 'listora-personal-runner',
      AWS_REGION: 'us-east-1',
    });
    expect(config.automation).toMatchObject({
      fakeSiteUrl: 'http://127.0.0.1:4400',
      profiles: { mercari: { limits: { runsPerHour: 12 } } },
    });
    expect(config.runnerLaunch).toEqual({
      kind: 'ecs',
      cluster: 'listora-personal',
      service: 'listora-personal-runner',
      region: 'us-east-1',
    });
    // Locally the worker starts the runner as a child process; production must say how.
    expect(loadWorkerConfig({ DATABASE_URL }).runnerLaunch).toEqual({ kind: 'process' });
    expect(
      captureConfigError({ DATABASE_URL, NODE_ENV: 'production', BROWSER_RUNNER_LAUNCH: 'ecs' })
        .issues,
    ).toEqual([
      'BROWSER_RUNNER_CLUSTER is required',
      'BROWSER_RUNNER_SERVICE is required',
      'AWS_REGION must be an AWS region',
    ]);
    expect(captureConfigError({ DATABASE_URL, NODE_ENV: 'production' }).issues).toEqual([
      'BROWSER_RUNNER_LAUNCH must be one of process, ecs, none',
    ]);
  });

  it('treats an empty FAKE_MARKETPLACE_URL or COGNITO_USER_POOL_ID as unset', () => {
    expect(
      loadWorkerConfig({ DATABASE_URL, FAKE_MARKETPLACE_URL: '', COGNITO_USER_POOL_ID: '' }),
    ).toMatchObject({
      marketplaces: { fakeMarketplaceUrl: undefined },
      cognitoUserPool: undefined,
    });
  });

  it('reads the eBay keyset and the token vault it refreshes and checks connections with', () => {
    expect(
      loadWorkerConfig({
        DATABASE_URL,
        EBAY_ENV: 'fake',
        EBAY_FAKE_URL: 'http://127.0.0.1:4110',
        TOKEN_KMS_KEY_ID: 'alias/listora-staging-tokens',
      }).marketplaces,
    ).toMatchObject({
      ebay: { environment: 'fake' },
      tokenVault: { driver: 'kms', keyId: 'alias/listora-staging-tokens' },
    });
    // Without a vault eBay still lists for the configured development seller; nothing connects.
    expect(
      loadWorkerConfig({ DATABASE_URL, EBAY_ENV: 'fake', EBAY_FAKE_URL: 'http://127.0.0.1:4110' })
        .marketplaces.tokenVault,
    ).toBeUndefined();
  });

  it('reports every invalid key at once', () => {
    expect(
      captureConfigError({
        LOG_LEVEL: 'loud',
        WORKER_CONCURRENCY: '0',
        WORKER_TASK_CONCURRENCY: '101',
        OPERATION_RETRY_DELAY_SCALE: '2',
        FAKE_MARKETPLACE_URL: 'ftp://fake',
        AI_AUTO_ESCALATE: 'sometimes',
        COGNITO_USER_POOL_ID: 'my-pool',
      }).issues,
    ).toEqual([
      'DATABASE_URL is required',
      'LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent',
      'WORKER_CONCURRENCY must be an integer from 1 to 100',
      'WORKER_TASK_CONCURRENCY must be an integer from 1 to 100',
      'OPERATION_RETRY_DELAY_SCALE must be a number from 0.001 to 1',
      'FAKE_MARKETPLACE_URL must be an http:// or https:// URL',
      'COGNITO_USER_POOL_ID must be a user pool id such as us-east-1_AbC123xyZ',
      'AI_AUTO_ESCALATE must be on or off',
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

  it('reads the Depop settings, and reports a bad one with the rest', () => {
    expect(loadWorkerConfig({ DATABASE_URL }).marketplaces.depop).toBeUndefined();
    expect(
      loadWorkerConfig({
        DATABASE_URL,
        DEPOP_ENV: 'fake',
        DEPOP_USER_CONNECTION_ID: 'connection-1',
      }).marketplaces.depop,
    ).toMatchObject({ environment: 'fake', seller: { connectionId: 'connection-1' } });
    expect(() =>
      loadWorkerConfig({ DATABASE_URL, DEPOP_ENV: 'production', LOG_LEVEL: 'loud' }),
    ).toThrow(/LOG_LEVEL[\s\S]*DEPOP_CLIENT_ID is required when DEPOP_ENV is production/);
  });

  it('reads the eBay settings, and reports a bad one with the rest', () => {
    expect(
      loadWorkerConfig({ DATABASE_URL, EBAY_ENV: 'fake', EBAY_USER_CONNECTION_ID: 'connection-1' })
        .marketplaces.ebay,
    ).toMatchObject({ environment: 'fake', seller: { connectionId: 'connection-1' } });
    expect(() =>
      loadWorkerConfig({ DATABASE_URL, EBAY_ENV: 'sandbox', LOG_LEVEL: 'loud' }),
    ).toThrow(/LOG_LEVEL[\s\S]*EBAY_CLIENT_ID is required when EBAY_ENV is sandbox/);
    expect(() =>
      loadWorkerConfig({
        DATABASE_URL,
        EBAY_ENV: 'production',
        EBAY_CLIENT_ID: 'id',
        EBAY_CLIENT_SECRET: 'secret',
        EBAY_USER_REFRESH_TOKEN: 'v^1.1#secret-refresh',
      }),
    ).toThrow(/EBAY_USER_REFRESH_TOKEN is not allowed when EBAY_ENV is production/);
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
