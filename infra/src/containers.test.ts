import { existsSync } from 'node:fs';

import { loadApiConfig } from '@listora/api/src/config.ts';
import { loadMigrateConfig } from '@listora/db';
import { loadWorkerConfig } from '@listora/worker/src/config.ts';
import { describe, expect, it } from 'vitest';

import {
  API_PORT,
  CONTAINER_NAMES,
  containerEnvironment,
  containerSecretNames,
  MIGRATE_COMMAND,
  type ContainerName,
} from './containers.ts';

const DATABASE_URL = 'postgres://listora@db.internal:5432/listora?sslmode=verify-full';

/** What a task's process sees: the plain environment plus every injected secret. */
function taskEnvironment(container: ContainerName): NodeJS.ProcessEnv {
  return {
    ...containerEnvironment(container, DATABASE_URL),
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
    expect(loadWorkerConfig(taskEnvironment('worker'))).toMatchObject({ logLevel: 'info' });
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
      const url = new URL(containerEnvironment(container, DATABASE_URL)['DATABASE_URL'] ?? '');
      expect(url.password).toBe('');
      expect(containerSecretNames(container)).toContain('PGPASSWORD');
    }
  });
});
