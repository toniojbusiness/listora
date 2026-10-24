import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { ENVIRONMENT_NAMES } from './config.ts';
import { deployRoleName } from './stacks/deploy-access-stack.ts';
import { stackList, synthesize } from './test-support.ts';

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  environment?: string;
  permissions?: Record<string, string>;
  steps: Step[];
}

const source = readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const workflow = parse(source) as {
  on: Record<string, { inputs: Record<string, { options: string[] }> }>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const job = workflow.jobs['deploy'];
if (job === undefined) throw new Error('deploy.yml has no deploy job');

describe('deploy workflow', () => {
  it('runs only when dispatched by hand, never on pushes or pull requests', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.on['workflow_dispatch']?.inputs['environment']?.options).toEqual([
      ...ENVIRONMENT_NAMES,
    ]);
  });

  it('deploys only main, inside the protected GitHub environment of the same name', () => {
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.environment).toBe('${{ inputs.environment }}');
  });

  it('assumes the deploy role through OIDC and holds no AWS keys', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(source).not.toMatch(/secrets\.|aws-access-key-id|aws-secret-access-key/);
    const login = job.steps.find((step) =>
      step.uses?.startsWith('aws-actions/configure-aws-credentials@'),
    );
    expect(login?.with?.['role-to-assume']).toBe(
      `arn:aws:iam::\${{ vars.AWS_ACCOUNT_ID }}:role/${deployRoleName('${{ inputs.environment }}')}`,
    );
    expect(login?.with?.['allowed-account-ids']).toBe('${{ vars.AWS_ACCOUNT_ID }}');
  });

  it('pins every action to a commit', () => {
    for (const step of job.steps) {
      if (step.uses !== undefined) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('deploys every stack except deploy-access, which only an administrator deploys', () => {
    const deploy = job.steps.find((step) => step.run?.includes('cdk deploy --require-approval'));
    const deployed = [...(deploy?.run ?? '').matchAll(/"listora-\$LISTORA_ENV-([a-z-]+)"/g)].map(
      (match) => match[1],
    );
    const { stacks } = synthesize('staging');
    const expected = stackList(stacks)
      .map((stack) => stack.stackName.replace('listora-staging-', ''))
      .filter((name) => name !== 'deploy-access');
    expect(deployed.sort()).toEqual(expected.sort());
  });
});
