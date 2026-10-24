import { assertNever } from '@listora/shared';

import { APP_SECRETS, type ServiceName } from './config.ts';

/** The port the API container listens on behind the load balancer. */
export const API_PORT = 3000;

/** Container command per service; both run from the same image (the root Dockerfile). */
export const SERVICE_COMMANDS: Readonly<Record<ServiceName, readonly string[]>> = {
  api: ['node', 'apps/api/src/main.ts'],
  worker: ['node', 'apps/worker/src/main.ts'],
};

/**
 * Plain (non-secret) environment of a service's container: only keys the process reads
 * (`.env.example`). A task that adds a required key adds it here, and `containers.test.ts`
 * fails until it does, because it runs each process's real config loader on this output.
 *
 * `databaseUrl` names the host, port, database, and user but no password: node-postgres
 * falls back to `PGPASSWORD` for a URL without one, and ECS injects that from the RDS secret.
 */
export function containerEnvironment(
  service: ServiceName,
  databaseUrl: string,
): Record<string, string> {
  const common = { DATABASE_URL: databaseUrl, LOG_LEVEL: 'info' };
  switch (service) {
    case 'api':
      return { API_HOST: '0.0.0.0', API_PORT: String(API_PORT), ...common };
    case 'worker':
      return common;
    default:
      return assertNever(service);
  }
}

/** Environment variables ECS fills from Secrets Manager for a service. */
export function containerSecretNames(service: ServiceName): string[] {
  return [
    'PGPASSWORD',
    ...APP_SECRETS.filter((secret) => secret.services.includes(service)).map(
      (secret) => secret.envVar,
    ),
  ];
}
