import { Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';

import { AVAILABILITY_ZONE_COUNT, type DeployTarget, type EnvironmentSettings } from '../config.ts';

/** Every Listora stack gets its environment's settings and deploy target. */
export interface ListoraStackProps extends StackProps {
  readonly settings: EnvironmentSettings;
  readonly target: DeployTarget;
}

/**
 * Base class of every Listora stack. CDK would look up an account's availability zones at
 * synthesis time, which needs AWS credentials; instead they are the deploy target's chosen
 * zones, or else resolve at deploy time (`Fn::GetAZs`), so synthesis is offline and the
 * templates are the same on every machine.
 */
export class ListoraStack extends Stack {
  private readonly chosenZones: readonly string[] | undefined;

  constructor(scope: Construct, id: string, props: ListoraStackProps) {
    super(scope, id, props);
    this.chosenZones = props.target.availabilityZones;
  }

  override get availabilityZones(): string[] {
    if (this.chosenZones !== undefined) return [...this.chosenZones];
    return Array.from({ length: AVAILABILITY_ZONE_COUNT }, (_, index) =>
      Fn.select(index, Fn.getAzs()),
    );
  }
}

/**
 * Removal policy for resources that are cheap to recreate but useful to keep in a protected
 * environment (log groups, operator-set secrets).
 */
export function removalPolicyFor(settings: EnvironmentSettings): RemovalPolicy {
  return settings.protectData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
}

/**
 * Where every Fargate task of the environment runs (`taskEgress`): the private `app`
 * subnets behind NAT, or the public subnets with a public address as the only way out.
 */
export function taskPlacement(settings: EnvironmentSettings): {
  readonly subnets: ec2.SubnetSelection;
  readonly assignPublicIp: boolean;
} {
  const publicIp = settings.network.taskEgress.via === 'public-ip';
  return {
    subnets: {
      subnetType: publicIp ? ec2.SubnetType.PUBLIC : ec2.SubnetType.PRIVATE_WITH_EGRESS,
    },
    assignPublicIp: publicIp,
  };
}
