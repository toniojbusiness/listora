import { existsSync } from 'node:fs';

import { loadApiConfig } from '@listora/api/src/config.ts';
import { loadMigrateConfig } from '@listora/db';
import { loadWorkerConfig } from '@listora/worker/src/config.ts';
import { loadRunnerConfig } from '@listora/worker/src/runner/config.ts';
import { describe, expect, it } from 'vitest';

import {
  API_PORT,
  CONTAINER_NAMES,
  containerEnvironment,
  containerSecretNames,
  MIGRATE_COMMAND,
  RUNNER_COMMAND,
  SERVICE_COMMANDS,
  signInResources,
  type ContainerName,
  type PhotoStorage,
  type ServiceResources,
} from './containers.ts';

const DATABASE_URL = 'postgres://listora@db.internal:5432/listora?sslmode=verify-full';
const PHOTO_STORAGE: PhotoStorage = {
  bucket: 'listora-staging-photos',
  region: 'us-east-1',
  publicBaseUrl: 'https://d111111abcdef8.cloudfront.net',
};
const TOKEN_KEY_ARN = 'arn:aws:kms:us-east-1:111122223333:key/0b6f7b3e-0000-4000-8000-000000000001';
const USER_POOL = { userPoolId: 'us-east-1_AbC123xyZ', clientIds: ['1example23456789abcdefghij'] };
const RESOURCES: ServiceResources = {
  photoStorage: PHOTO_STORAGE,
  signIn: { driver: 'cognito', ...USER_POOL },
  runner: { cluster: 'listora-staging', service: 'runner', region: 'us-east-1' },
  tokenKeyArn: TOKEN_KEY_ARN,
};

/** What a task's process sees: the plain environment, the image's, and every injected secret. */
function taskEnvironment(container: ContainerName): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    ...containerEnvironment(container, DATABASE_URL, RESOURCES),
    ...Object.fromEntries(containerSecretNames(container).map((name) => [name, 'placeholder'])),
  };
}

describe('the sign-in an environment gets', () => {
  it('is the cognito driver with its user pool in an owner-pool environment', () => {
    expect(signInResources({ via: 'owner-pool' }, USER_POOL)).toEqual({
      driver: 'cognito',
      ...USER_POOL,
    });
  });

  it('is the dev driver only where the environment signs in with dev', () => {
    expect(signInResources({ via: 'dev' }, undefined)).toEqual({ driver: 'dev' });
  });

  it('never falls back to the dev driver when the owner pool is missing, and never mixes the two', () => {
    expect(() => signInResources({ via: 'owner-pool' }, undefined)).toThrow(
      'an owner-pool environment needs its user pool',
    );
    expect(() =>
      signInResources({ via: 'owner-pool' }, { userPoolId: USER_POOL.userPoolId, clientIds: [] }),
    ).toThrow('the user pool needs an app client');
    expect(() => signInResources({ via: 'dev' }, USER_POOL)).toThrow(
      'a dev sign-in environment has no user pool',
    );
  });

  it('gives the API the cognito driver, its pool, and its clients, and the worker the pool', () => {
    expect(loadApiConfig(taskEnvironment('api')).auth).toEqual({
      driver: 'cognito',
      cognito: { region: 'us-east-1', ...USER_POOL },
    });
    expect(containerEnvironment('api', DATABASE_URL, RESOURCES)).not.toHaveProperty(
      'AUTH_DEV_SECRET',
    );
    expect(containerEnvironment('worker', DATABASE_URL, RESOURCES)).toMatchObject({
      COGNITO_USER_POOL_ID: USER_POOL.userPoolId,
    });
    expect(loadWorkerConfig(taskEnvironment('worker')).cognitoUserPool).toEqual({
      region: 'us-east-1',
      userPoolId: USER_POOL.userPoolId,
    });
  });

  it('gives a dev environment the dev driver and no Cognito keys', () => {
    const dev = { ...RESOURCES, signIn: { driver: 'dev' } } as const;
    expect(containerEnvironment('api', DATABASE_URL, dev)).toMatchObject({ AUTH_DRIVER: 'dev' });
    for (const container of ['api', 'worker'] as const) {
      expect(Object.keys(containerEnvironment(container, DATABASE_URL, dev))).not.toContain(
        'COGNITO_USER_POOL_ID',
      );
    }
  });
});

describe('container environment', () => {
  // These run the processes' real config loaders, so a task that adds a required key to the
  // API or worker fails here until the compute stack provides it.
  it('is accepted by the API config loader as-is', () => {
    expect(loadApiConfig(taskEnvironment('api'))).toMatchObject({
      host: '0.0.0.0',
      port: API_PORT,
      databaseUrl: DATABASE_URL,
      logLevel: 'info',
    });
  });

  it('is accepted by the worker config loader as-is', () => {
    expect(loadWorkerConfig(taskEnvironment('worker'))).toMatchObject({
      logLevel: 'info',
      runnerLaunch: { kind: 'ecs', cluster: 'listora-staging', service: 'runner' },
    });
  });

  it('is accepted by the browser runner config loader as-is: KMS, S3, and its own service', () => {
    expect(loadRunnerConfig(taskEnvironment('runner'))).toMatchObject({
      logLevel: 'info',
      tokenVault: { driver: 'kms', keyId: TOKEN_KEY_ARN, region: 'us-east-1' },
      storage: { driver: 's3', bucket: PHOTO_STORAGE.bucket },
      launch: { kind: 'ecs', cluster: 'listora-staging', service: 'runner' },
    });
    expect(containerSecretNames('runner')).toEqual(['PGPASSWORD']);
  });

  it('runs commands whose entry points exist', () => {
    for (const command of [...Object.values(SERVICE_COMMANDS), RUNNER_COMMAND]) {
      const [node, script = ''] = command;
      expect(node).toBe('node');
      expect(existsSync(new URL(`../../${script}`, import.meta.url)), script).toBe(true);
    }
  });

  it('gives the API and the worker the same S3 photo storage, Anthropic provider, and KMS token key', () => {
    for (const load of [
      () => loadApiConfig(taskEnvironment('api')),
      () => loadWorkerConfig(taskEnvironment('worker')),
    ]) {
      expect(load()).toMatchObject({
        storage: {
          driver: 's3',
          bucket: PHOTO_STORAGE.bucket,
          region: PHOTO_STORAGE.region,
          publicBaseUrl: PHOTO_STORAGE.publicBaseUrl,
        },
        ai: { provider: 'anthropic', anthropicApiKey: 'placeholder' },
        marketplaces: { tokenVault: { driver: 'kms', keyId: TOKEN_KEY_ARN, region: 'us-east-1' } },
      });
    }
    expect(containerEnvironment('migrate', DATABASE_URL)).not.toHaveProperty('STORAGE_DRIVER');
  });

  it('is accepted by the migrate CLI config loader as-is, with only the database secret', () => {
    const [node, script = '', ...args] = MIGRATE_COMMAND;
    expect(node).toBe('node');
    expect(existsSync(new URL(`../../${script}`, import.meta.url))).toBe(true);
    expect(loadMigrateConfig(args, taskEnvironment('migrate'))).toMatchObject({
      command: 'latest',
      databaseUrl: DATABASE_URL,
      logLevel: 'info',
    });
    expect(containerSecretNames('migrate')).toEqual(['PGPASSWORD']);
  });

  it('gets the database password only from the injected secret', () => {
    for (const container of CONTAINER_NAMES) {
      const environment = containerEnvironment(container, DATABASE_URL, RESOURCES);
      const url = new URL(environment['DATABASE_URL'] ?? '');
      expect(url.password).toBe('');
      expect(containerSecretNames(container)).toContain('PGPASSWORD');
    }
  });
});
