import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { ENVIRONMENT_NAMES } from './config.ts';
import { deployRoleName } from './stacks/deploy-access-stack.ts';
import { MIGRATE_OUTPUTS, migrateTaskNames } from './stacks/migrate-stack.ts';
import { stackList, synthesize } from './test-support.ts';

interface Step {
  name?: string;
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

  /** The stacks each `cdk deploy` step deploys, by step index. */
  const deploys = job.steps.flatMap((step, index) =>
    step.run?.includes('cdk deploy') === true
      ? [
          {
            index,
            stacks: [...step.run.matchAll(/"listora-\$LISTORA_ENV-([a-z-]+)"/g)].map(
              (match) => match[1] ?? '',
            ),
          },
        ]
      : [],
  );
  const deployIndex = (stack: string): number => {
    const found = deploys.find((deploy) => deploy.stacks.includes(stack));
    if (found === undefined) throw new Error(`no step deploys ${stack}`);
    return found.index;
  };
  const stepIndex = (name: string): number => {
    const index = job.steps.findIndex((step) => step.name === name);
    if (index < 0) throw new Error(`no step named ${name}`);
    return index;
  };

  it('deploys every stack except deploy-access, which only an administrator deploys', () => {
    const deployed = new Set(deploys.flatMap((deploy) => deploy.stacks));
    const { stacks } = synthesize('staging');
    const expected = stackList(stacks)
      .map((stack) => stack.stackName.replace('listora-staging-', ''))
      .filter((name) => name !== 'deploy-access');
    expect([...deployed].sort()).toEqual(expected.sort());
  });

  it('migrates the schema after the image push and before any service deploys', () => {
    const migrate = stepIndex('Run schema migrations');
    expect(stepIndex('Build and push the application image')).toBeLessThan(deployIndex('migrate'));
    expect(deployIndex('migrate')).toBeLessThan(migrate);
    for (const stack of ['compute', 'observability']) {
      expect(deploys.filter((deploy) => deploy.stacks.includes(stack))).toHaveLength(1);
      expect(deployIndex(stack)).toBeGreaterThan(migrate);
    }
  });

  it('runs the migration task by name and fails the deploy unless it exits 0', () => {
    const names = migrateTaskNames('$LISTORA_ENV');
    const run = job.steps[stepIndex('Run schema migrations')]?.run ?? '';
    expect(run).toContain(`cluster="${names.cluster}"`);
    expect(run).toContain(`--task-definition "${names.family}"`);
    expect(run).toContain(`--stack-name "${names.stack}"`);
    for (const output of Object.values(MIGRATE_OUTPUTS)) expect(run).toContain(`output ${output}`);
    // The stack says whether the task needs a public address (public-IP egress, no NAT).
    expect(run).toContain(`public_ip=$(output ${MIGRATE_OUTPUTS.assignPublicIp})`);
    expect(run).toContain('assignPublicIp=$public_ip}');
    expect(run).not.toContain('aws ecs wait');
    expect(run).toContain('.tasks[0].lastStatus');
    expect(run).toMatch(/while true; do\n[\s\S]*"\$status" == STOPPED \]\]; then break; fi/);
    expect(run).toContain('.tasks[0].containers[0].exitCode');
    expect(run).toMatch(/if \[\[ "\$code" != 0 \]\]; then\n.*\n\s*exit 1/);
  });
});
