import { loadApiConfig } from '@listora/api/src/config.ts';
import { loadWorkerConfig } from '@listora/worker/src/config.ts';
import { describe, expect, it } from 'vitest';

import { SERVICE_NAMES, type ServiceName } from './config.ts';
import { API_PORT, containerEnvironment, containerSecretNames } from './containers.ts';

const DATABASE_URL = 'postgres://listora@db.internal:5432/listora?sslmode=verify-full';

/** What a task's process sees: the plain environment plus every injected secret. */
function taskEnvironment(service: ServiceName): NodeJS.ProcessEnv {
  return {
    ...containerEnvironment(service, DATABASE_URL),
    ...Object.fromEntries(containerSecretNames(service).map((name) => [name, 'placeholder'])),
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

  it('gets the database password only from the injected secret', () => {
    for (const service of SERVICE_NAMES) {
      const url = new URL(containerEnvironment(service, DATABASE_URL)['DATABASE_URL'] ?? '');
      expect(url.password).toBe('');
      expect(containerSecretNames(service)).toContain('PGPASSWORD');
    }
  });
});
