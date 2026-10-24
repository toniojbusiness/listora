import { CfnOutput, Fn } from 'aws-cdk-lib';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type { Construct } from 'constructs';

import { containerEnvironment, MIGRATE_COMMAND } from '../containers.ts';
import { ListoraStack, removalPolicyFor, taskPlacement, type ListoraStackProps } from './common.ts';
import { containerSecrets, databaseUrl } from './task-config.ts';

export interface MigrateStackProps extends ListoraStackProps {
  readonly vpc: ec2.IVpc;
  readonly workerSecurityGroup: ec2.ISecurityGroup;
  readonly database: rds.DatabaseInstance;
  readonly repository: ecr.IRepository;
}

/**
 * Names of the migration task's resources. They are fixed so the deploy workflow and the
 * deploy role refer to them by name, before the stack exists and without lookups.
 */
export function migrateTaskNames(environment: string) {
  const name = `listora-${environment}-migrate`;
  return {
    stack: name,
    cluster: name,
    family: name,
    taskRole: `${name}-task`,
    executionRole: `${name}-execution`,
    logGroup: `/listora/${environment}/migrate`,
  };
}

/** CloudFormation outputs the deploy workflow passes to `ecs run-task`. */
export const MIGRATE_OUTPUTS = {
  subnetIds: 'SubnetIds',
  securityGroupId: 'SecurityGroupId',
  assignPublicIp: 'AssignPublicIp',
};

/**
 * The one-off ECS task that applies schema migrations (`MIGRATE_COMMAND`). The deploy
 * workflow deploys this stack, runs the task and waits for it to exit 0, and only then
 * deploys the compute stack, so new code never starts against an old schema. Running tasks
 * keep serving while migrations apply, so every migration must work with the code already
 * running (expand, then contract: infra/README.md).
 *
 * The task is the worker's twin for the database: the same image tag, `DATABASE_URL` without a
 * password plus `PGPASSWORD` from the RDS secret, the task subnets, and the worker security
 * group, the one the database admits besides the API's. Its task role has no permissions. It
 * has a cluster of its own because the compute stack's does not exist yet on a first deploy.
 */
export class MigrateStack extends ListoraStack {
  readonly cluster: ecs.Cluster;
  readonly taskDefinition: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: MigrateStackProps) {
    super(scope, id, props);
    const { settings, target } = props;
    const names = migrateTaskNames(target.environment);

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: names.cluster,
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    });

    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: names.logGroup,
      retention: settings.logRetention,
      removalPolicy: removalPolicyFor(settings),
    });
    const role = (constructId: string, roleName: string, description: string) =>
      new iam.Role(this, constructId, {
        roleName,
        description,
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      });

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'Task', {
      family: names.family,
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      executionRole: role(
        'ExecutionRole',
        names.executionRole,
        'Starts the schema migration task: image pull, logs, database password',
      ),
      taskRole: role('TaskRole', names.taskRole, 'Schema migration task (no AWS permissions)'),
    });
    this.taskDefinition.addContainer('migrate', {
      image: ecs.ContainerImage.fromEcrRepository(props.repository, target.imageTag),
      command: [...MIGRATE_COMMAND],
      environment: containerEnvironment('migrate', databaseUrl(props.database)),
      secrets: containerSecrets(this, target.environment, 'migrate', props.database),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'migrate' }),
      readonlyRootFilesystem: true,
    });

    const placement = taskPlacement(settings);
    const subnets = props.vpc.selectSubnets(placement.subnets);
    new CfnOutput(this, MIGRATE_OUTPUTS.subnetIds, { value: Fn.join(',', subnets.subnetIds) });
    new CfnOutput(this, MIGRATE_OUTPUTS.securityGroupId, {
      value: props.workerSecurityGroup.securityGroupId,
    });
    // `ecs run-task` wants ENABLED in public subnets, where the address is the only way out.
    new CfnOutput(this, MIGRATE_OUTPUTS.assignPublicIp, {
      value: placement.assignPublicIp ? 'ENABLED' : 'DISABLED',
    });
  }
}
