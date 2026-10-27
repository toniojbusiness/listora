import type { App } from 'aws-cdk-lib';
import { ManagedPolicy, PermissionsBoundary } from 'aws-cdk-lib/aws-iam';

import { ENVIRONMENT_SETTINGS, type DeployTarget } from './config.ts';
import { AuthStack } from './stacks/auth-stack.ts';
import type { ListoraStackProps } from './stacks/common.ts';
import { ComputeStack } from './stacks/compute-stack.ts';
import { DataStack } from './stacks/data-stack.ts';
import { DeployAccessStack, roleBoundaryName } from './stacks/deploy-access-stack.ts';
import { EmailStack } from './stacks/email-stack.ts';
import { MigrateStack } from './stacks/migrate-stack.ts';
import { NetworkStack } from './stacks/network-stack.ts';
import { ObservabilityStack } from './stacks/observability-stack.ts';
import { RegistryStack } from './stacks/registry-stack.ts';
import { SecretsStack } from './stacks/secrets-stack.ts';
import { StorageStack } from './stacks/storage-stack.ts';

export interface ListoraStacks {
  readonly deployAccess: DeployAccessStack;
  readonly registry: RegistryStack;
  readonly network: NetworkStack;
  readonly secrets: SecretsStack;
  readonly data: DataStack;
  readonly migrate: MigrateStack;
  readonly storage: StorageStack;
  readonly email: EmailStack;
  /** The owner pool, where the environment signs in with one (`signIn`); absent elsewhere. */
  readonly auth: AuthStack | undefined;
  readonly compute: ComputeStack;
  readonly observability: ObservabilityStack;
}

export function stackName(target: DeployTarget, name: string): string {
  return `listora-${target.environment}-${name}`;
}

/**
 * Defines one environment's stacks in `app`. Stacks are split by lifecycle: long-lived state
 * (data, storage, email, secrets, registry) changes rarely and is protected, while compute and
 * observability change on every deploy and can be replaced freely. The migrate stack holds
 * the schema migration task, which the deploy workflow runs before it deploys compute.
 */
export function defineListora(app: App, target: DeployTarget): ListoraStacks {
  const settings = ENVIRONMENT_SETTINGS[target.environment];
  const props = (name: string, description: string): ListoraStackProps => ({
    stackName: stackName(target, name),
    description: `Listora ${target.environment}: ${description}`,
    env: { account: target.account, region: target.region },
    terminationProtection: settings.protectData,
    tags: { project: 'listora', environment: target.environment },
    settings,
    target,
  });
  const id = (name: string): string => stackName(target, name);

  const deployAccess = new DeployAccessStack(
    app,
    id('deploy-access'),
    props('deploy-access', 'GitHub OIDC deploy role (bootstrap)'),
  );
  const registry = new RegistryStack(
    app,
    id('registry'),
    props('registry', 'application image repository'),
  );
  const network = new NetworkStack(app, id('network'), props('network', 'VPC and security groups'));
  const secrets = new SecretsStack(
    app,
    id('secrets'),
    props('secrets', 'KMS token key and app secrets'),
  );
  const data = new DataStack(app, id('data'), {
    ...props('data', 'RDS PostgreSQL'),
    vpc: network.vpc,
    securityGroup: network.databaseSecurityGroup,
  });
  const migrate = new MigrateStack(app, id('migrate'), {
    ...props('migrate', 'schema migration task'),
    vpc: network.vpc,
    workerSecurityGroup: network.workerSecurityGroup,
    database: data.database,
    repository: registry.repository,
  });
  const storage = new StorageStack(
    app,
    id('storage'),
    props('storage', 'photo bucket and CloudFront'),
  );
  const email = new EmailStack(app, id('email'), props('email', 'SES inbound sale email'));
  let auth: AuthStack | undefined;
  if (settings.signIn.via === 'owner-pool') {
    auth = new AuthStack(app, id('auth'), props('auth', 'Cognito user pool for sign-in'));
    // The pool emails through the email stack's SES identities, which it names, not references.
    auth.addStackDependency(email, 'the SES identities the user pool sends from must exist');
  }
  const front = settings.ingress.via === 'load-balancer' ? 'an ALB' : 'an API Gateway HTTP API';
  const compute = new ComputeStack(app, id('compute'), {
    ...props('compute', `ECS Fargate api and worker behind ${front}, and the browser runner`),
    vpc: network.vpc,
    ingressSecurityGroup: network.ingressSecurityGroup,
    apiSecurityGroup: network.apiSecurityGroup,
    workerSecurityGroup: network.workerSecurityGroup,
    database: data.database,
    repository: registry.repository,
    runnerRepository: registry.runnerRepository,
    photoBucket: storage.photoBucket,
    photoCdnDomain: storage.photoDistribution.distributionDomainName,
    inboundMailBucket: email.inboundMailBucket,
    ...(email.saleEmail === undefined ? {} : { saleEmail: email.saleEmail }),
    tokenKey: secrets.tokenKey,
    ...(auth === undefined ? {} : { userPool: { pool: auth.userPool, appClient: auth.appClient } }),
  });
  // App secrets are referenced by name, which CDK cannot see as a dependency.
  compute.addStackDependency(secrets, 'app secrets must exist before tasks read them');
  const observability = new ObservabilityStack(app, id('observability'), {
    ...props('observability', 'alarms'),
    endpoint: compute.endpoint,
    services: compute.services,
    database: data.database,
  });

  // Every role of the stacks a deploy changes carries the role boundary, which the restricted
  // execution policy requires (deploy/execution-policy.ts; infra/README.md, Trust boundary). The
  // deploy-access stack, which an administrator deploys, is outside the bootstrap.
  const deployed = [registry, network, secrets, data, migrate, storage, email, auth, compute];
  for (const stack of [...deployed, observability]) {
    if (stack === undefined) continue;
    const boundary = roleBoundaryName(target.environment);
    PermissionsBoundary.of(stack).apply(
      ManagedPolicy.fromManagedPolicyName(stack, 'RoleBoundary', boundary),
    );
  }

  return {
    deployAccess,
    registry,
    network,
    secrets,
    data,
    migrate,
    storage,
    email,
    auth,
    compute,
    observability,
  };
}
