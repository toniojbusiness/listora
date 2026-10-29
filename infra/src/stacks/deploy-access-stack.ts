import { CfnOutput, Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

import { CDK_BOOTSTRAP_QUALIFIER, CDK_TOOLKIT_STACK_NAME } from '../bootstrap.ts';
import type { DeployTarget, EnvironmentName } from '../config.ts';
import { ListoraStack, type ListoraStackProps } from './common.ts';
import { clusterName } from './compute-stack.ts';
import { migrateTaskNames } from './migrate-stack.ts';
import { IMAGE_REPOSITORY_NAME, RUNNER_IMAGE_REPOSITORY_NAME } from './registry-stack.ts';

export const GITHUB_OIDC_ISSUER = 'token.actions.githubusercontent.com';

/** The only branch whose workflows may deploy. */
export const DEPLOY_BRANCH_REF = 'refs/heads/main';

export function deployRoleName(environment: string): string {
  return `listora-${environment}-github-deploy`;
}

/**
 * The `sub` claim of a GitHub OIDC token of a job running in the environment's GitHub
 * environment, in the repository's immutable subject form: the owner and the repository named
 * with their ids as well as their names, so no re-created owner or repository of the same name
 * matches.
 */
export function githubOidcSubject(
  target: Pick<
    DeployTarget,
    'environment' | 'githubRepository' | 'githubOwnerId' | 'githubRepositoryId'
  >,
): string {
  const [owner, name] = target.githubRepository.split('/');
  return `repo:${String(owner)}@${target.githubOwnerId}/${String(name)}@${target.githubRepositoryId}:environment:${target.environment}`;
}

/**
 * The one workflow file that deploys an environment: personal with Deploy personal (on every
 * push to `main`), staging and prod with the manual Deploy workflow.
 */
export function deployWorkflowFile(environment: EnvironmentName): string {
  return environment === 'personal' ? 'deploy-personal.yml' : 'deploy.yml';
}

/**
 * The `job_workflow_ref` claim of a GitHub OIDC token of a job of the environment's deploy
 * workflow on `main`: the workflow file and branch the job's definition came from. Another
 * workflow of the repository that names the same GitHub environment (a new or edited file, or
 * one calling a reusable workflow) carries a different value, so it cannot assume the role.
 */
export function githubOidcWorkflowRef(
  target: Pick<DeployTarget, 'environment' | 'githubRepository'>,
): string {
  return `${target.githubRepository}/.github/workflows/${deployWorkflowFile(target.environment)}@${DEPLOY_BRANCH_REF}`;
}

/** The bootstrap's restricted CloudFormation execution policy (deploy/execution-policy.ts). */
export function executionPolicyName(environment: string): string {
  return `listora-${environment}-cdk-execution`;
}

/**
 * The permissions boundary every role of the environment's stacks carries, which the execution
 * policy requires of every role it creates or changes (deploy/execution-policy.ts).
 */
export function roleBoundaryName(environment: string): string {
  return `listora-${environment}-role-boundary`;
}

/**
 * The bootstrap roles a deploy uses: the deploy role (which runs CloudFormation with the
 * restricted execution role) and the asset publishing roles. Never the lookup role, which can
 * read the whole account: synthesis is offline.
 */
export const DEPLOY_BOOTSTRAP_ROLES = ['deploy', 'file-publishing', 'image-publishing'] as const;

/**
 * The role GitHub Actions assumes through OIDC to deploy one environment; no long-lived AWS
 * keys exist anywhere. Only a job of the environment's deploy workflow (`deployWorkflowFile`) of
 * this repository (named by its immutable ids), running on `main` in the GitHub environment of
 * the same name (which carries the protection rules: deployments from `main` only), can assume
 * it.
 *
 * The role itself can assume Listora's CDK bootstrap deploy and asset publishing roles of this
 * account and region (which perform the CloudFormation deployment), push to and pull from the application and runner
 * image repositories, read this environment's stacks and Listora's bootstrap stack and
 * execution policy (to check them, never to change them), run and watch the schema migration
 * task, and read and roll the services of this environment's cluster (to put a release that
 * fails its health check back on the task definitions it replaced). Through the bootstrap roles
 * it can deploy only this environment's stacks (Listora's bootstrap template), and only what the
 * bootstrap's restricted CloudFormation execution policy allows, which excludes this stack: the trust boundary is the GitHub environment's protection rules plus
 * that policy (infra/README.md). An administrator deploys this stack once per account, before
 * the first workflow run.
 */
export class DeployAccessStack extends ListoraStack {
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: ListoraStackProps) {
    super(scope, id, props);
    const { target } = props;

    // An account has one provider per URL. One that exists (another app's) is trusted as it
    // is, never changed.
    const provider =
      target.githubOidcProvider === 'existing'
        ? iam.OidcProviderNative.fromOidcProviderArn(
            this,
            'GitHubOidc',
            `arn:${this.partition}:iam::${this.account}:oidc-provider/${GITHUB_OIDC_ISSUER}`,
          )
        : new iam.OidcProviderNative(this, 'GitHubOidc', {
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
          [`${GITHUB_OIDC_ISSUER}:sub`]: githubOidcSubject(target),
          // The GitHub environment allows deployments from main only; this holds even if that
          // rule is loosened by mistake.
          [`${GITHUB_OIDC_ISSUER}:ref`]: DEPLOY_BRANCH_REF,
          // Only the environment's own deploy workflow, as committed on main.
          [`${GITHUB_OIDC_ISSUER}:job_workflow_ref`]: githubOidcWorkflowRef(target),
        },
      }),
    });

    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'UseCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: DEPLOY_BOOTSTRAP_ROLES.map(
          (role) =>
            `arn:${this.partition}:iam::${this.account}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-${role}-role-${this.account}-${this.region}`,
        ),
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
        sid: 'PushApplicationImages',
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:BatchGetImage',
          'ecr:CompleteLayerUpload',
          'ecr:DescribeImages',
          // Pulls the deployed images' layers as the build cache.
          'ecr:GetDownloadUrlForLayer',
          'ecr:InitiateLayerUpload',
          'ecr:PutImage',
          'ecr:UploadLayerPart',
        ],
        resources: [IMAGE_REPOSITORY_NAME, RUNNER_IMAGE_REPOSITORY_NAME].map(
          (name) => `arn:${this.partition}:ecr:${this.region}:${this.account}:repository/${name}`,
        ),
      }),
    );

    const migrate = migrateTaskNames(target.environment);
    const ecsArn = (resource: string) =>
      `arn:${this.partition}:ecs:${this.region}:${this.account}:${resource}`;
    const stackArn = (name: string) =>
      `arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/${name}/*`;
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadStackOutputs',
        actions: ['cloudformation:DescribeStacks', 'cloudformation:ListStackResources'],
        resources: [stackArn(`listora-${target.environment}-*`)],
      }),
    );
    // scripts/deploy-personal.sh checks, before it changes anything, that the bootstrap is
    // Listora's template running CloudFormation with the restricted policy, and that the policy
    // and the role boundary are the committed documents. Only an administrator changes them.
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CheckRestrictedBootstrap',
        actions: ['cloudformation:DescribeStacks'],
        resources: [stackArn(CDK_TOOLKIT_STACK_NAME)],
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CheckExecutionPolicy',
        actions: ['iam:GetPolicy', 'iam:GetPolicyVersion'],
        resources: [executionPolicyName, roleBoundaryName].map(
          (name) => `arn:${this.partition}:iam::${this.account}:policy/${name(target.environment)}`,
        ),
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CheckZones',
        // DescribeAvailabilityZones has no resource-level permissions.
        actions: ['ec2:DescribeAvailabilityZones'],
        resources: ['*'],
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CheckSesIdentities',
        actions: ['ses:GetEmailIdentity'],
        resources: [`arn:${this.partition}:ses:${this.region}:${this.account}:identity/*`],
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RunSchemaMigrations',
        actions: ['ecs:RunTask'],
        resources: [ecsArn(`task-definition/${migrate.family}:*`)],
        conditions: { ArnEquals: { 'ecs:cluster': ecsArn(`cluster/${migrate.cluster}`) } },
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WatchSchemaMigrations',
        actions: ['ecs:DescribeTasks'],
        resources: [ecsArn(`task/${migrate.cluster}/*`)],
      }),
    );
    // The release's health check: which task definitions the services run, and, when the
    // release fails it, moving them back to the ones it replaced.
    const cluster = clusterName(target.environment);
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RollServices',
        actions: ['ecs:DescribeServices', 'ecs:UpdateService'],
        resources: [ecsArn(`service/${cluster}/*`)],
      }),
    );
    // A service's tasks run with the compute stack's roles (CloudFormation names them after the
    // stack), which ECS may check the caller can pass when it moves the service.
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassServiceRoles',
        actions: ['iam:PassRole'],
        resources: [
          `arn:${this.partition}:iam::${this.account}:role/listora-${target.environment}-compute-*`,
        ],
        conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadTaskDefinitions',
        // DescribeTaskDefinition has no resource-level permissions.
        actions: ['ecs:DescribeTaskDefinition'],
        resources: ['*'],
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassSchemaMigrationRoles',
        actions: ['iam:PassRole'],
        resources: [migrate.taskRole, migrate.executionRole].map(
          (name) => `arn:${this.partition}:iam::${this.account}:role/${name}`,
        ),
        conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      }),
    );

    new CfnOutput(this, 'DeployRoleArn', { value: this.deployRole.roleArn });
  }
}
