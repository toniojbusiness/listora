import { Template } from 'aws-cdk-lib/assertions';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PLACEHOLDER_SHAPES } from '../placeholders.ts';
import { deployRoleName } from '../stacks/deploy-access-stack.ts';
import { stackList, synthesize } from '../test-support.ts';
import {
  ATTACHABLE_MANAGED_POLICIES,
  cdkExecutionPolicy,
  executionPolicyName,
  SERVICE_PREFIXES,
  type PolicyStatement,
} from './execution-policy.ts';

interface Resource {
  Type: string;
  Properties?: { RoleName?: unknown; ManagedPolicyArns?: unknown[] };
}

const ACCOUNT = '976033325938';
const list = (value: string | readonly string[]): readonly string[] =>
  typeof value === 'string' ? [value] : value;
const matches = (pattern: string, value: string): boolean =>
  new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  ).test(value);

/** Whether `statements` allow `action` on `resource`, IAM style: any Deny wins. */
function allows(statements: readonly PolicyStatement[], action: string, resource: string): boolean {
  const applies = (statement: PolicyStatement) =>
    list(statement.Action).some((pattern) => matches(pattern, action)) &&
    list(statement.Resource).some((pattern) => matches(pattern, resource));
  const applying = statements.filter(applies);
  return (
    applying.some((statement) => statement.Effect === 'Allow') &&
    !applying.some((statement) => statement.Effect === 'Deny')
  );
}

/** Every resource the deploys create, per shape: every stack except deploy-access. */
const deployed = PLACEHOLDER_SHAPES.map(({ name, environment, overrides }) => {
  const { stacks } = synthesize(environment, overrides);
  const resources = stackList(stacks)
    .filter((stack) => stack.stackName !== `listora-${environment}-deploy-access`)
    .flatMap((stack) =>
      Object.values(
        (Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }).Resources,
      ),
    );
  return { name, environment, resources };
});

describe('the restricted CDK execution policy', () => {
  it.each(deployed)(
    'allows every resource type the $name stacks create',
    ({ environment, resources }) => {
      const policy = cdkExecutionPolicy(environment, ACCOUNT);
      for (const type of new Set(resources.map((resource) => resource.Type))) {
        // CDK custom resources (Custom::*) run as a Lambda function the stack also creates.
        if (type.startsWith('Custom::')) continue;
        const namespace = type.split('::')[1] ?? '';
        if (namespace === 'IAM') continue;
        const prefix = SERVICE_PREFIXES[namespace];
        expect(prefix, `${type} needs an entry in SERVICE_PREFIXES`).toBeDefined();
        expect(allows(policy.Statement, `${prefix ?? ''}:CreateSomething`, '*'), type).toBe(true);
      }
    },
  );

  it.each(deployed)(
    'can read every stack the $name stacks take outputs from (Fn::GetStackOutput)',
    ({ environment, resources }) => {
      const policy = cdkExecutionPolicy(environment, ACCOUNT);
      const producers = new Set(
        [
          ...JSON.stringify(resources).matchAll(/"Fn::GetStackOutput":\{"StackName":"([^"]+)"/g),
        ].map((match) => match[1] ?? ''),
      );
      expect(producers.size).toBeGreaterThan(0);
      for (const stack of producers) {
        const arn = `arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/${stack}/d812ad80-0000`;
        expect(allows(policy.Statement, 'cloudformation:DescribeStacks', arn), stack).toBe(true);
      }
      // Never another app's stacks or the bootstrap's.
      for (const other of ['PrequalChecker-prod', 'CDKToolkit', 'CDKToolkit-listora']) {
        const arn = `arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/${other}/x`;
        expect(allows(policy.Statement, 'cloudformation:DescribeStacks', arn), other).toBe(false);
      }
    },
  );

  it.each(deployed)(
    'covers every IAM resource and managed policy of the $name stacks',
    ({ environment, resources }) => {
      const policy = cdkExecutionPolicy(environment, ACCOUNT);
      const iamTypes = new Set(
        resources.filter((resource) => resource.Type.startsWith('AWS::IAM::')).map((r) => r.Type),
      );
      // Inline policies on the stacks' roles are fine; a new IAM type (a user, a managed
      // policy, an OIDC provider) needs a deliberate change to the policy.
      expect([...iamTypes].sort()).toEqual(['AWS::IAM::Policy', 'AWS::IAM::Role']);
      for (const resource of resources.filter((r) => r.Type === 'AWS::IAM::Role')) {
        const name = resource.Properties?.RoleName;
        // Generated names start with the stack name, which starts with listora-<env>-.
        if (typeof name === 'string') {
          expect(name.startsWith(`listora-${environment}-`), name).toBe(true);
          expect(
            allows(policy.Statement, 'iam:CreateRole', `arn:aws:iam::${ACCOUNT}:role/${name}`),
          ).toBe(true);
        }
        for (const arn of resource.Properties?.ManagedPolicyArns ?? []) {
          const resolved = JSON.stringify(arn).replace('${AWS::Partition}', 'aws');
          expect(
            ATTACHABLE_MANAGED_POLICIES.some((allowed) => resolved.includes(allowed)),
            resolved,
          ).toBe(true);
        }
      }
    },
  );

  it('never allows changing the deploy role, the bootstrap roles, or any other role', () => {
    const { Statement } = cdkExecutionPolicy('personal', ACCOUNT);
    const role = (name: string) => `arn:aws:iam::${ACCOUNT}:role/${name}`;
    for (const action of ['iam:CreateRole', 'iam:PutRolePolicy', 'iam:UpdateAssumeRolePolicy']) {
      expect(allows(Statement, action, role(deployRoleName('personal')))).toBe(false);
      expect(
        allows(Statement, action, role('cdk-hnb659fds-deploy-role-976033325938-us-east-1')),
      ).toBe(false);
      expect(allows(Statement, action, role('listora-prod-compute-TaskRole'))).toBe(false);
      expect(allows(Statement, action, role('admin'))).toBe(false);
      expect(allows(Statement, action, role('listora-personal-compute-TaskRole'))).toBe(true);
    }
    expect(allows(Statement, 'iam:CreateUser', `arn:aws:iam::${ACCOUNT}:user/someone`)).toBe(false);
    expect(allows(Statement, 'iam:CreateOpenIDConnectProvider', '*')).toBe(false);
    expect(allows(Statement, 's3:PutBucketPolicy', 'arn:aws:s3:::cdk-hnb659fds-assets-x')).toBe(
      false,
    );
    expect(allows(Statement, 'organizations:LeaveOrganization', '*')).toBe(false);
  });

  it('attaches only the listed managed policies, never AdministratorAccess', () => {
    const attach = cdkExecutionPolicy('personal', ACCOUNT).Statement.find((statement) =>
      list(statement.Action).includes('iam:AttachRolePolicy'),
    );
    expect(attach?.Condition).toEqual({
      ArnEquals: { 'iam:PolicyARN': ATTACHABLE_MANAGED_POLICIES },
    });
    expect(ATTACHABLE_MANAGED_POLICIES.join()).not.toMatch(/AdministratorAccess|PowerUser|IAMFull/);
  });

  it('fits the managed policy size limit', () => {
    // IAM counts the document without whitespace; 6,144 characters at most.
    expect(JSON.stringify(cdkExecutionPolicy('staging', ACCOUNT)).length).toBeLessThan(6144);
    expect(executionPolicyName('personal')).toBe('listora-personal-cdk-execution');
  });

  it('prints the document from its command line and refuses bad arguments', () => {
    const script = fileURLToPath(new URL('execution-policy.ts', import.meta.url));
    const printed = spawnSync('node', [script, 'personal', ACCOUNT], { encoding: 'utf8' });
    expect(printed.status).toBe(0);
    expect(JSON.parse(printed.stdout)).toEqual(cdkExecutionPolicy('personal', ACCOUNT));
    const refused = spawnSync('node', [script, 'personal', '123'], { encoding: 'utf8' });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('usage:');
    // Two Node processes start here; on a loaded machine that takes longer than the default 5 s.
  }, 30_000);
});
