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
  cdnDistributionId: 'E2EXAMPLE0001',
};
const TOKEN_KEY_ARN = 'arn:aws:kms:us-east-1:111122223333:key/0b6f7b3e-0000-4000-8000-000000000001';
const USER_POOL = {
  userPoolId: 'us-east-1_AbC123xyZ',
  clientIds: ['1example23456789abcdefghij'],
  ownerEmail: 'owner@example.com',
};
const RESOURCES: ServiceResources = {
  photoStorage: PHOTO_STORAGE,
  signIn: { driver: 'cognito', ...USER_POOL, inviteEmailVerification: 'ses' },
  runner: { cluster: 'listora-staging', service: 'runner', region: 'us-east-1' },
  tokenKeyArn: TOKEN_KEY_ARN,
  ownerAlerts: {
    environment: 'staging',
    email: { from: 'alerts@example.com', to: 'owner@example.com' },
  },
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
    expect(
      signInResources({ via: 'owner-pool', inviteEmailVerification: 'ses' }, USER_POOL),
    ).toEqual({ driver: 'cognito', ...USER_POOL, inviteEmailVerification: 'ses' });
  });

  it('is the dev driver only where the environment signs in with dev', () => {
    expect(signInResources({ via: 'dev' }, undefined)).toEqual({ driver: 'dev' });
  });

  it('never falls back to the dev driver when the owner pool is missing, and never mixes the two', () => {
    const ownerPool = { via: 'owner-pool', inviteEmailVerification: 'none' } as const;
    expect(() => signInResources(ownerPool, undefined)).toThrow(
      'an owner-pool environment needs its user pool',
    );
    expect(() => signInResources(ownerPool, { ...USER_POOL, clientIds: [] })).toThrow(
      'the user pool needs an app client',
    );
    expect(() => signInResources({ via: 'dev' }, USER_POOL)).toThrow(
      'a dev sign-in environment has no user pool',
    );
  });

  it('gives the API the cognito driver, its pool, and its clients, and the worker the pool', () => {
    const api = loadApiConfig(taskEnvironment('api'));
    expect(api.auth).toEqual({
      driver: 'cognito',
      cognito: {
        region: 'us-east-1',
        userPoolId: USER_POOL.userPoolId,
        clientIds: USER_POOL.clientIds,
      },
    });
    // Invite-only, with the pool's owner, verifying invitees' addresses in SES's sandbox.
    expect(api.signUp).toEqual({ mode: 'invite', ownerEmail: USER_POOL.ownerEmail });
    expect(api.inviteEmailVerification).toBe('ses');
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

  it('keeps buyer data retention off in every deployment until the owner turns it on', () => {
    expect(containerEnvironment('worker', DATABASE_URL, RESOURCES)).toMatchObject({
      BUYER_DATA_RETENTION: 'off',
    });
    expect(loadWorkerConfig(taskEnvironment('worker')).buyerDataRetention).toBe('off');
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
    // Only the worker may invalidate the photo CDN (the public package photos it moves).
    expect(loadWorkerConfig(taskEnvironment('worker')).storage).toMatchObject({
      cdnDistributionId: PHOTO_STORAGE.cdnDistributionId,
    });
    expect(taskEnvironment('api')).not.toHaveProperty('STORAGE_CDN_DISTRIBUTION_ID');
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

  it('reads sale emails from SES where the environment receives them, and none elsewhere', () => {
    const saleEmail = {
      inboundDomain: 'in.example.com',
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/111122223333/listora-staging-sale-email',
      bucket: 'listora-staging-inbound-mail',
      region: 'us-east-1',
    };
    const env = (container: ContainerName, resources: ServiceResources): NodeJS.ProcessEnv => ({
      ...taskEnvironment(container),
      ...containerEnvironment(container, DATABASE_URL, resources),
    });
    const ses = {
      driver: 'ses',
      inboundDomain: saleEmail.inboundDomain,
      queueUrl: saleEmail.queueUrl,
      bucket: saleEmail.bucket,
      region: saleEmail.region,
    };
    expect(loadWorkerConfig(env('worker', { ...RESOURCES, saleEmail })).emailIngest).toEqual(ses);
    expect(loadApiConfig(env('api', { ...RESOURCES, saleEmail })).emailIngest).toEqual(ses);
    // Without a domain nothing is read, and never the folder driver's local inbox.
    expect(loadWorkerConfig(taskEnvironment('worker')).emailIngest).toEqual({ driver: 'off' });
    expect(loadApiConfig(taskEnvironment('api')).emailIngest).toEqual({ driver: 'off' });
    expect(containerEnvironment('runner', DATABASE_URL, RESOURCES)).not.toHaveProperty(
      'EMAIL_INGEST',
    );
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
