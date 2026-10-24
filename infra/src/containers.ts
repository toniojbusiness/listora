import { assertNever } from '@listora/shared';

import { APP_SECRETS, SERVICE_NAMES, type ServiceName } from './config.ts';

/** The port the API container listens on behind the load balancer. */
export const API_PORT = 3000;

/**
 * Every container Listora runs from the one image (the root Dockerfile): the two long-running
 * services, and `migrate`, the one-off task that applies schema migrations on each deploy.
 */
export const CONTAINER_NAMES = [...SERVICE_NAMES, 'migrate'] as const;
export type ContainerName = (typeof CONTAINER_NAMES)[number];

/** Container command per service; both run from the same image (the root Dockerfile). */
export const SERVICE_COMMANDS: Readonly<Record<ServiceName, readonly string[]>> = {
  api: ['node', 'apps/api/src/main.ts'],
  worker: ['node', 'apps/worker/src/main.ts'],
};

/** The migration task's command: apply every pending migration (packages/db/src/cli.ts). */
export const MIGRATE_COMMAND: readonly string[] = ['node', 'packages/db/src/cli.ts', 'latest'];

/** The photo storage the API and the worker share: the storage stack's bucket and CDN. */
export interface PhotoStorage {
  readonly bucket: string;
  readonly region: string;
  /** The CloudFront URL that serves the bucket's `public/` keys. */
  readonly publicBaseUrl: string;
}

/**
 * Plain (non-secret) environment of a container: only keys the process reads
 * (`.env.example`). A task that adds a required key adds it here, and `containers.test.ts`
 * fails until it does, because it runs each process's real config loader on this output.
 * The migration task has the worker's database access and nothing else.
 *
 * `databaseUrl` names the host, port, database, and user but no password: node-postgres
 * falls back to `PGPASSWORD` for a URL without one, and ECS injects that from the RDS secret.
 * The API and the worker share the S3 photo storage (the API stores uploads, the worker
 * processes and analyzes them) and call the Anthropic API with the injected
 * `ANTHROPIC_API_KEY`.
 */
export function containerEnvironment(
  container: 'migrate',
  databaseUrl: string,
): Record<string, string>;
export function containerEnvironment(
  container: ContainerName,
  databaseUrl: string,
  photoStorage: PhotoStorage,
): Record<string, string>;
export function containerEnvironment(
  container: ContainerName,
  databaseUrl: string,
  photoStorage?: PhotoStorage,
): Record<string, string> {
  const common = { DATABASE_URL: databaseUrl, LOG_LEVEL: 'info' };
  const services = (): Record<string, string> => {
    if (photoStorage === undefined) throw new Error(`the ${container} container needs storage`);
    return {
      ...common,
      AI_PROVIDER: 'anthropic',
      STORAGE_DRIVER: 's3',
      STORAGE_S3_BUCKET: photoStorage.bucket,
      STORAGE_S3_REGION: photoStorage.region,
      STORAGE_PUBLIC_BASE_URL: photoStorage.publicBaseUrl,
    };
  };
  switch (container) {
    case 'api':
      // `dev` is the only auth driver this build has; T-31 switches deployed APIs to `cognito`.
      return { API_HOST: '0.0.0.0', API_PORT: String(API_PORT), AUTH_DRIVER: 'dev', ...services() };
    case 'worker':
      return services();
    case 'migrate':
      return common;
    default:
      return assertNever(container);
  }
}

/** Environment variables ECS fills from Secrets Manager for a container. */
export function containerSecretNames(container: ContainerName): string[] {
  return [
    'PGPASSWORD',
    ...APP_SECRETS.filter((secret) => secret.services.some((service) => service === container)).map(
      (secret) => secret.envVar,
    ),
  ];
}
