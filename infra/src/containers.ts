import { assertNever } from '@listora/shared';

import { APP_SECRETS, SERVICE_NAMES, type ServiceName } from './config.ts';

/** The port the API container listens on behind the load balancer. */
export const API_PORT = 3000;

/**
 * Every container Listora runs: the two long-running services and `migrate`, the one-off task
 * that applies schema migrations on each deploy, from the application image (the root
 * Dockerfile); and `runner`, the on-demand browser runner, from the same sources with Chromium
 * added (the Dockerfile's `runner` stage).
 */
export const CONTAINER_NAMES = [...SERVICE_NAMES, 'runner', 'migrate'] as const;
export type ContainerName = (typeof CONTAINER_NAMES)[number];

/** Container command per service; both run from the same image (the root Dockerfile). */
export const SERVICE_COMMANDS: Readonly<Record<ServiceName, readonly string[]>> = {
  api: ['node', 'apps/api/src/main.ts'],
  worker: ['node', 'apps/worker/src/main.ts'],
};

/** The browser runner's command (apps/worker/src/runner/main.ts). */
export const RUNNER_COMMAND: readonly string[] = ['node', 'apps/worker/src/runner/main.ts'];

/** The migration task's command: apply every pending migration (packages/db/src/cli.ts). */
export const MIGRATE_COMMAND: readonly string[] = ['node', 'packages/db/src/cli.ts', 'latest'];

/** The photo storage the API and the worker share: the storage stack's bucket and CDN. */
export interface PhotoStorage {
  readonly bucket: string;
  readonly region: string;
  /** The CloudFront URL that serves the bucket's `public/` keys. */
  readonly publicBaseUrl: string;
}

/** What the long-running containers are configured with besides the database. */
export interface Deployment {
  readonly photoStorage: PhotoStorage;
  /** The browser runner's ECS service: the worker starts it, and it scales itself to zero. */
  readonly runner: { readonly cluster: string; readonly service: string; readonly region: string };
  /** The KMS key that wraps the data keys of stored marketplace credentials. */
  readonly tokenKeyArn: string;
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
 * `ANTHROPIC_API_KEY`. The worker starts the browser runner's service when automated work
 * waits; the runner decrypts sellers' sessions with the token key and keeps the redacted
 * screenshots of failed runs in the photo bucket's private `automation/` prefix.
 */
export function containerEnvironment(
  container: 'migrate',
  databaseUrl: string,
): Record<string, string>;
export function containerEnvironment(
  container: ContainerName,
  databaseUrl: string,
  deployment: Deployment,
): Record<string, string>;
export function containerEnvironment(
  container: ContainerName,
  databaseUrl: string,
  deployment?: Deployment,
): Record<string, string> {
  const common = { DATABASE_URL: databaseUrl, LOG_LEVEL: 'info' };
  const deployed = (): Deployment => {
    if (deployment === undefined) throw new Error(`the ${container} container needs storage`);
    return deployment;
  };
  const storage = ({ photoStorage }: Deployment): Record<string, string> => ({
    STORAGE_DRIVER: 's3',
    STORAGE_S3_BUCKET: photoStorage.bucket,
    STORAGE_S3_REGION: photoStorage.region,
    STORAGE_PUBLIC_BASE_URL: photoStorage.publicBaseUrl,
  });
  const runnerService = ({ runner }: Deployment): Record<string, string> => ({
    BROWSER_RUNNER_LAUNCH: 'ecs',
    BROWSER_RUNNER_CLUSTER: runner.cluster,
    BROWSER_RUNNER_SERVICE: runner.service,
    AWS_REGION: runner.region,
  });
  const services = (): Record<string, string> => ({
    ...common,
    AI_PROVIDER: 'anthropic',
    ...storage(deployed()),
  });
  switch (container) {
    case 'api':
      // Deployed APIs switch to `cognito` (with COGNITO_USER_POOL_ID and COGNITO_CLIENT_IDS) once
      // the user pool exists; docs/auth.md lists what it needs.
      return { API_HOST: '0.0.0.0', API_PORT: String(API_PORT), AUTH_DRIVER: 'dev', ...services() };
    // The worker gets COGNITO_USER_POOL_ID (and its task role cognito-idp:AdminGetUser and AdminDeleteUser) with
    // the user pool, so account deletions can delete Cognito users.
    case 'worker':
      return { ...services(), ...runnerService(deployed()) };
    case 'runner':
      return {
        ...common,
        ...storage(deployed()),
        ...runnerService(deployed()),
        TOKEN_KMS_KEY_ID: deployed().tokenKeyArn,
      };
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
