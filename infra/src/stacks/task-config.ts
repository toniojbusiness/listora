import * as ecs from 'aws-cdk-lib/aws-ecs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

import { APP_SECRETS, secretName, type EnvironmentName } from '../config.ts';
import { containerSecretNames, type ContainerName } from '../containers.ts';
import { DATABASE_NAME, DATABASE_USER } from './data-stack.ts';

/**
 * The `DATABASE_URL` of every container: host, port, database, and user, but no password
 * (ECS injects `PGPASSWORD`), and the server certificate is verified.
 */
export function databaseUrl(database: rds.DatabaseInstance): string {
  return (
    `postgres://${DATABASE_USER}@${database.dbInstanceEndpointAddress}:` +
    `${database.dbInstanceEndpointPort}/${DATABASE_NAME}?sslmode=verify-full`
  );
}

/**
 * The secrets ECS injects into a container (`containerSecretNames`): `PGPASSWORD` from the
 * RDS-generated secret, and each app secret from Secrets Manager by name. Any other name is
 * a programming error, never silently filled with some other secret.
 */
export function containerSecrets(
  scope: Construct,
  environment: EnvironmentName,
  container: ContainerName,
  database: rds.DatabaseInstance,
): Record<string, ecs.Secret> {
  if (database.secret === undefined) throw new Error('the database must have a secret');
  const databasePassword = ecs.Secret.fromSecretsManager(database.secret, 'password');
  return Object.fromEntries(
    containerSecretNames(container).map((envVar) => {
      if (envVar === 'PGPASSWORD') return [envVar, databasePassword];
      const secret = APP_SECRETS.find((candidate) => candidate.envVar === envVar);
      if (secret === undefined)
        throw new Error(`${envVar} is neither PGPASSWORD nor an app secret`);
      const stored = secretsmanager.Secret.fromSecretNameV2(
        scope,
        `${container}-${secret.name}`,
        secretName(environment, secret.name),
      );
      return [envVar, ecs.Secret.fromSecretsManager(stored)];
    }),
  );
}
