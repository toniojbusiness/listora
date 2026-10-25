import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { loadRunnerConfig, RunnerConfigError } from './config.ts';

const DATABASE_URL = 'postgres://listora:hunter2@127.0.0.1:55432/listora';
const KEY_ARN = 'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555';
const LOCAL_KEY = randomBytes(32).toString('base64');

describe('loadRunnerConfig', () => {
  it('runs locally with the local token key, local storage, and a two-minute idle exit', () => {
    expect(loadRunnerConfig({ DATABASE_URL, TOKEN_ENCRYPTION_KEY: LOCAL_KEY })).toMatchObject({
      databaseUrl: DATABASE_URL,
      logLevel: 'info',
      tokenVault: { driver: 'local' },
      storage: { driver: 'local' },
      idleExitMs: 120_000,
      launch: { kind: 'process' },
      automation: { stepTimeoutMs: 30_000, callTimeoutMs: 300_000 },
    });
  });

  it('reads the production settings: KMS, S3, and its own ECS service', () => {
    const config = loadRunnerConfig({
      DATABASE_URL,
      NODE_ENV: 'production',
      TOKEN_KMS_KEY_ID: KEY_ARN,
      STORAGE_DRIVER: 's3',
      STORAGE_S3_BUCKET: 'listora-personal-photos',
      STORAGE_S3_REGION: 'us-east-1',
      STORAGE_PUBLIC_BASE_URL: 'https://d1.cloudfront.net',
      BROWSER_RUNNER_LAUNCH: 'ecs',
      BROWSER_RUNNER_CLUSTER: 'listora-personal',
      BROWSER_RUNNER_SERVICE: 'listora-personal-runner',
      AWS_REGION: 'us-east-1',
      RUNNER_IDLE_EXIT_SECONDS: '0',
    });
    expect(config).toMatchObject({
      tokenVault: { driver: 'kms', keyId: KEY_ARN, region: 'us-east-1' },
      storage: { driver: 's3', bucket: 'listora-personal-photos' },
      launch: { kind: 'ecs', service: 'listora-personal-runner' },
      idleExitMs: 0,
    });
  });

  it('refuses to start without a token key, since every session it opens is sealed', () => {
    expect(() => loadRunnerConfig({ DATABASE_URL })).toThrow(
      'set TOKEN_KMS_KEY_ID or TOKEN_ENCRYPTION_KEY',
    );
  });

  it('reports every invalid key at once, never echoing a value', () => {
    const secret = randomBytes(16).toString('base64');
    let error: unknown;
    try {
      loadRunnerConfig({
        DATABASE_URL: 'mysql://root:hunter2@db/x',
        NODE_ENV: 'production',
        TOKEN_ENCRYPTION_KEY: secret,
        RUNNER_IDLE_EXIT_SECONDS: 'soon',
        AUTOMATION_POSHMARK_PACE_MS: '10-20',
        BROWSER_RUNNER_LAUNCH: 'ecs',
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RunnerConfigError);
    expect((error as RunnerConfigError).issues).toEqual([
      'DATABASE_URL is required and must be a postgres:// URL',
      'RUNNER_IDLE_EXIT_SECONDS must be an integer from 0 to 3600',
      'TOKEN_ENCRYPTION_KEY must be 32 bytes in base64 (openssl rand -base64 32)',
      'AUTOMATION_POSHMARK_PACE_MS must be min-max milliseconds, from 300 up to 60000',
      'BROWSER_RUNNER_CLUSTER is required',
      'BROWSER_RUNNER_SERVICE is required',
      'AWS_REGION must be an AWS region',
    ]);
    expect(String(error)).not.toContain('hunter2');
    expect(String(error)).not.toContain(secret);
  });
});
