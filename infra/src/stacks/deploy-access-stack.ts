import { CfnOutput, Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

import { ListoraStack, type ListoraStackProps } from './common.ts';
import { IMAGE_REPOSITORY_NAME } from './registry-stack.ts';

export const GITHUB_OIDC_ISSUER = 'token.actions.githubusercontent.com';

/** The default qualifier of `cdk bootstrap` roles. */
const CDK_BOOTSTRAP_QUALIFIER = 'hnb659fds';

export function deployRoleName(environment: string): string {
  return `listora-${environment}-github-deploy`;
}

/**
 * The role GitHub Actions assumes through OIDC to deploy one environment; no long-lived AWS
 * keys exist anywhere. Only a workflow job running in this repository's GitHub environment
 * of the same name (`staging` or `prod`, which carries the protection rules) can assume it.
 *
 * The role itself can do two things: assume the CDK bootstrap roles of this account and
 * region (which perform the CloudFormation deployment), and push to the application image
 * repository. An administrator deploys this stack once per account, before the first
 * workflow run (infra/README.md).
 */
export class DeployAccessStack extends ListoraStack {
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: ListoraStackProps) {
    super(scope, id, props);
    const { target } = props;

    const provider = new iam.OidcProviderNative(this, 'GitHubOidc', {
      url: `https://${GITHUB_OIDC_ISSUER}`,
      clientIds: ['sts.amazonaws.com'],
    });

    this.deployRole = new iam.Role(this, 'DeployRole', {
      roleName: deployRoleName(target.environment),
      description: `GitHub Actions deploys of ${target.githubRepository} to ${target.environment}`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          [`${GITHUB_OIDC_ISSUER}:aud`]: 'sts.amazonaws.com',
          [`${GITHUB_OIDC_ISSUER}:sub`]: `repo:${target.githubRepository}:environment:${target.environment}`,
        },
      }),
    });

    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'UseCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:${this.partition}:iam::${this.account}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-*-${this.account}-${this.region}`,
        ],
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrLogin',
        // GetAuthorizationToken has no resource-level permissions.
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PushApplicationImage',
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:BatchGetImage',
          'ecr:CompleteLayerUpload',
          'ecr:DescribeImages',
          'ecr:InitiateLayerUpload',
          'ecr:PutImage',
          'ecr:UploadLayerPart',
        ],
        resources: [
          `arn:${this.partition}:ecr:${this.region}:${this.account}:repository/${IMAGE_REPOSITORY_NAME}`,
        ],
      }),
    );

    new CfnOutput(this, 'DeployRoleArn', { value: this.deployRole.roleArn });
  }
}
