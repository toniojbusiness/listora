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

/** The AWS resources the API and the worker share, which their environment names. */
export interface ServiceResources {
  readonly photoStorage: PhotoStorage;
  /** The KMS key that wraps the data keys of marketplace tokens (`TOKEN_KMS_KEY_ID`). */
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
 * processes and analyzes them), call the Anthropic API with the injected
 * `ANTHROPIC_API_KEY`, and use the KMS token key: the API seals new marketplace grants
 * (`kms:GenerateDataKey` only), the worker also opens them (`kms:Decrypt`).
 */
export function containerEnvironment(
  container: 'migrate',
  databaseUrl: string,
): Record<string, string>;
export function containerEnvironment(
  container: ContainerName,
  databaseUrl: string,
  resources: ServiceResources,
): Record<string, string>;
export function containerEnvironment(
  container: ContainerName,
  databaseUrl: string,
  resources?: ServiceResources,
): Record<string, string> {
  const common = { DATABASE_URL: databaseUrl, LOG_LEVEL: 'info' };
  const services = (): Record<string, string> => {
    if (resources === undefined) throw new Error(`the ${container} container needs its resources`);
    const { photoStorage } = resources;
    return {
      ...common,
      AI_PROVIDER: 'anthropic',
      STORAGE_DRIVER: 's3',
      STORAGE_S3_BUCKET: photoStorage.bucket,
      STORAGE_S3_REGION: photoStorage.region,
      STORAGE_PUBLIC_BASE_URL: photoStorage.publicBaseUrl,
      // eBay connects once the environment has an eBay keyset (EBAY_ENV, EBAY_CLIENT_ID,
      // EBAY_RUNAME, and the EBAY_CLIENT_SECRET secret; the eBay go-live task, T-35). Its
      // notifications then need EBAY_NOTIFICATION_ENDPOINT (the API's /webhooks/ebay URL),
      // EBAY_NOTIFICATION_ALERT_EMAIL, and the EBAY_NOTIFICATION_VERIFICATION_TOKEN secret in
      // both containers (docs/ebay-notifications.md).
      TOKEN_KMS_KEY_ID: resources.tokenKeyArn,
    };
  };
  switch (container) {
    case 'api':
      // Deployed APIs switch to `cognito` (with COGNITO_USER_POOL_ID and COGNITO_CLIENT_IDS) once
      // the user pool exists; docs/auth.md lists what it needs.
      return { API_HOST: '0.0.0.0', API_PORT: String(API_PORT), AUTH_DRIVER: 'dev', ...services() };
    // The worker gets COGNITO_USER_POOL_ID (and its task role cognito-idp:AdminGetUser and AdminDeleteUser) with
    // the user pool, so account deletions can delete Cognito users.
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
