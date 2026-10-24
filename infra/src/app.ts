import type { App } from 'aws-cdk-lib';

import { ENVIRONMENT_SETTINGS, type DeployTarget } from './config.ts';
import type { ListoraStackProps } from './stacks/common.ts';
import { ComputeStack } from './stacks/compute-stack.ts';
import { DataStack } from './stacks/data-stack.ts';
import { DeployAccessStack } from './stacks/deploy-access-stack.ts';
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
  const front = settings.ingress.via === 'load-balancer' ? 'an ALB' : 'an API Gateway HTTP API';
  const compute = new ComputeStack(app, id('compute'), {
    ...props('compute', `ECS Fargate api and worker behind ${front}`),
    vpc: network.vpc,
    ingressSecurityGroup: network.ingressSecurityGroup,
    apiSecurityGroup: network.apiSecurityGroup,
    workerSecurityGroup: network.workerSecurityGroup,
    database: data.database,
    repository: registry.repository,
    photoBucket: storage.photoBucket,
    photoCdnDomain: storage.photoDistribution.distributionDomainName,
    inboundMailBucket: email.inboundMailBucket,
    tokenKey: secrets.tokenKey,
  });
  // App secrets are referenced by name, which CDK cannot see as a dependency.
  compute.addStackDependency(secrets, 'app secrets must exist before tasks read them');
  const observability = new ObservabilityStack(app, id('observability'), {
    ...props('observability', 'alarms'),
    endpoint: compute.endpoint,
    services: compute.services,
    database: data.database,
  });

  return {
    deployAccess,
    registry,
    network,
    secrets,
    data,
    migrate,
    storage,
    email,
    compute,
    observability,
  };
}
