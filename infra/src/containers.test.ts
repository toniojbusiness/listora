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
  type ContainerName,
  type Deployment,
} from './containers.ts';

const DATABASE_URL = 'postgres://listora@db.internal:5432/listora?sslmode=verify-full';
const PHOTO_STORAGE = {
  bucket: 'listora-staging-photos',
  region: 'us-east-1',
  publicBaseUrl: 'https://d111111abcdef8.cloudfront.net',
};
const DEPLOYMENT: Deployment = {
  photoStorage: PHOTO_STORAGE,
  runner: { cluster: 'listora-staging', service: 'runner', region: 'us-east-1' },
  tokenKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555',
};

/** What a task's process sees: the plain environment, the image's, and every injected secret. */
function taskEnvironment(container: ContainerName): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    ...containerEnvironment(container, DATABASE_URL, DEPLOYMENT),
    ...Object.fromEntries(containerSecretNames(container).map((name) => [name, 'placeholder'])),
  };
}

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
      tokenCipher: { driver: 'kms', keyId: DEPLOYMENT.tokenKeyArn },
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

  it('gives the API and the worker the same S3 photo storage and the Anthropic provider', () => {
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
      const environment = containerEnvironment(container, DATABASE_URL, DEPLOYMENT);
      const url = new URL(environment['DATABASE_URL'] ?? '');
      expect(url.password).toBe('');
      expect(containerSecretNames(container)).toContain('PGPASSWORD');
    }
  });
});
