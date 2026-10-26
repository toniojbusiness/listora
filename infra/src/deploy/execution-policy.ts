// The CloudFormation execution policy of a restricted CDK bootstrap (infra/README.md, Trust
// boundary). `cdk bootstrap --cloudformation-execution-policies <arn>` makes this the ceiling on
// what any deploy into the account can change, instead of the default AdministratorAccess.
//
// `node infra/src/deploy/execution-policy.ts <env> <account>` prints the policy document as
// JSON; scripts/deploy-personal.sh creates the managed policy from it.
import { pathToFileURL } from 'node:url';

import { ENVIRONMENT_NAMES, type EnvironmentName } from '../config.ts';
import { deployRoleName } from '../stacks/deploy-access-stack.ts';

/** The managed policy's name in the account. */
export function executionPolicyName(environment: EnvironmentName): string {
  return `listora-${environment}-cdk-execution`;
}

/**
 * The IAM service prefix behind each CloudFormation resource namespace the stacks use
 * (`AWS::EC2::Subnet` is `ec2`). A stack that adds a resource of a namespace missing here fails
 * `execution-policy.test.ts`, so the policy grows with the stacks instead of failing a deploy.
 */
export const SERVICE_PREFIXES: Readonly<Record<string, string>> = {
  ApiGatewayV2: 'apigateway',
  ApplicationAutoScaling: 'application-autoscaling',
  CertificateManager: 'acm',
  CloudFront: 'cloudfront',
  CloudWatch: 'cloudwatch',
  Cognito: 'cognito-idp',
  EC2: 'ec2',
  ECR: 'ecr',
  ECS: 'ecs',
  ElasticLoadBalancingV2: 'elasticloadbalancing',
  Events: 'events',
  KMS: 'kms',
  Lambda: 'lambda',
  Logs: 'logs',
  RDS: 'rds',
  Route53: 'route53',
  S3: 's3',
  SES: 'ses',
  SNS: 'sns',
  SecretsManager: 'secretsmanager',
  SQS: 'sqs',
  ServiceDiscovery: 'servicediscovery',
};

/**
 * AWS managed policies a stack may attach to its roles (CDK's custom resource providers attach
 * the Lambda basic execution role). Attaching any other managed policy is refused.
 */
export const ATTACHABLE_MANAGED_POLICIES: readonly string[] = [
  'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
];

/** IAM actions on a stack's own roles: create, change, tag, pass, and delete them. */
const ROLE_ACTIONS = [
  'iam:CreateRole',
  'iam:DeleteRole',
  'iam:GetRole',
  'iam:UpdateRole',
  'iam:UpdateRoleDescription',
  'iam:UpdateAssumeRolePolicy',
  'iam:TagRole',
  'iam:UntagRole',
  'iam:ListRoleTags',
  'iam:PutRolePolicy',
  'iam:GetRolePolicy',
  'iam:DeleteRolePolicy',
  'iam:ListRolePolicies',
  'iam:ListAttachedRolePolicies',
  'iam:PassRole',
];

export interface PolicyStatement {
  readonly Sid: string;
  readonly Effect: 'Allow' | 'Deny';
  readonly Action: string | readonly string[];
  readonly Resource: string | readonly string[];
  readonly Condition?: Record<string, Record<string, string | readonly string[]>>;
}

export interface PolicyDocument {
  readonly Version: '2012-10-17';
  readonly Statement: readonly PolicyStatement[];
}

/**
 * What CloudFormation may do while deploying one environment's stacks:
 *
 * - every action of the services the stacks use (`SERVICE_PREFIXES`), reading the CDK
 *   bootstrap version parameter, and reading the environment's own stacks, which every weak
 *   cross-stack reference (`Fn::GetStackOutput`) needs;
 * - IAM only on roles named after the environment's stacks (`listora-<env>-*`, which
 *   CloudFormation's generated role names start with too), attaching only
 *   `ATTACHABLE_MANAGED_POLICIES`, plus the service-linked roles AWS creates on first use;
 * - never the GitHub deploy role or the OIDC provider (`deploy-access` is deployed by an
 *   administrator, outside this bootstrap), the bootstrap's own roles, or its assets bucket's
 *   policy and lifetime, and never an IAM user, group, or account setting (nothing grants them).
 *
 * Service actions are granted whole (`ec2:*`), so a deploy can still change any resource of
 * those services in the account, including another app's when the account is shared (the
 * personal account is). What a deploy changes is what the reviewed templates say; scoping
 * these grants to Listora's tagged resources, and a permissions boundary on every role (a
 * stack's role can still be given any inline permission), are the T-33 follow-up in
 * infra/README.md.
 */
export function cdkExecutionPolicy(environment: EnvironmentName, account: string): PolicyDocument {
  const role = (name: string) => `arn:aws:iam::${account}:role/${name}`;
  const services = [...new Set(Object.values(SERVICE_PREFIXES))].sort();
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ListoraServices',
        Effect: 'Allow',
        Action: services.map((service) => `${service}:*`),
        Resource: '*',
      },
      {
        Sid: 'ReadBootstrapVersion',
        Effect: 'Allow',
        Action: ['ssm:GetParameter', 'ssm:GetParameters'],
        Resource: `arn:aws:ssm:*:${account}:parameter/cdk-bootstrap/*`,
      },
      {
        Sid: 'ReadOwnStackOutputs',
        Effect: 'Allow',
        Action: 'cloudformation:DescribeStacks',
        Resource: `arn:aws:cloudformation:*:${account}:stack/listora-${environment}-*/*`,
      },
      {
        Sid: 'StackRoles',
        Effect: 'Allow',
        Action: ROLE_ACTIONS,
        Resource: role(`listora-${environment}-*`),
      },
      {
        Sid: 'StackRolesAttachOnlyKnownPolicies',
        Effect: 'Allow',
        Action: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
        Resource: role(`listora-${environment}-*`),
        Condition: { ArnEquals: { 'iam:PolicyARN': ATTACHABLE_MANAGED_POLICIES } },
      },
      {
        Sid: 'ServiceLinkedRoles',
        Effect: 'Allow',
        Action: ['iam:CreateServiceLinkedRole', 'iam:GetRole'],
        Resource: role('aws-service-role/*'),
      },
      {
        Sid: 'NeverTheDeployRoleOrBootstrapRoles',
        Effect: 'Deny',
        Action: 'iam:*',
        Resource: [role(deployRoleName(environment)), role('cdk-*')],
      },
      {
        Sid: 'NeverTheBootstrapBucket',
        Effect: 'Deny',
        Action: [
          's3:DeleteBucket',
          's3:DeleteBucketPolicy',
          's3:PutBucketPolicy',
          's3:PutLifecycleConfiguration',
        ],
        Resource: 'arn:aws:s3:::cdk-*',
      },
    ],
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [environment, account] = process.argv.slice(2);
  if (
    !ENVIRONMENT_NAMES.some((name) => name === environment) ||
    account === undefined ||
    !/^\d{12}$/.test(account)
  ) {
    process.stderr.write(
      `usage: node infra/src/deploy/execution-policy.ts <${ENVIRONMENT_NAMES.join('|')}> <12-digit account>\n`,
    );
    process.exit(2);
  }
  process.stdout.write(
    `${JSON.stringify(cdkExecutionPolicy(environment as EnvironmentName, account), null, 2)}\n`,
  );
}
