import { Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type { DeployTarget, EnvironmentSettings } from '../config.ts';

/** Every Listora stack gets its environment's settings and deploy target. */
export interface ListoraStackProps extends StackProps {
  readonly settings: EnvironmentSettings;
  readonly target: DeployTarget;
}

/** Every environment spans two availability zones. */
export const AVAILABILITY_ZONE_COUNT = 2;

/**
 * Base class of every Listora stack. CDK would look up an account's availability zones at
 * synthesis time, which needs AWS credentials; instead the zones resolve at deploy time
 * (`Fn::GetAZs`), so synthesis is offline and the templates are the same on every machine.
 */
export class ListoraStack extends Stack {
  override get availabilityZones(): string[] {
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
