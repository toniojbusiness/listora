import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { ENVIRONMENT_NAMES } from './config.ts';
import { DEPLOY_BRANCH_REF, deployRoleName } from './stacks/deploy-access-stack.ts';
import { MIGRATE_OUTPUTS, migrateTaskNames } from './stacks/migrate-stack.ts';
import { stackList, synthesize } from './test-support.ts';

interface Step {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  needs?: string;
  outputs?: Record<string, string>;
  environment?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
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
/** Personal deploys with its own workflow (deploy-personal.yml, below). */
const DEPLOYED_HERE = ENVIRONMENT_NAMES.filter((environment) => environment !== 'personal');

describe('deploy workflow', () => {
  it('runs only when dispatched by hand, never on pushes or pull requests', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.on['workflow_dispatch']?.inputs['environment']?.options).toEqual(DEPLOYED_HERE);
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

  it('deploys every stack of its environments except deploy-access, which only an administrator deploys', () => {
    const deployed = new Set(deploys.flatMap((deploy) => deploy.stacks));
    const expected = new Set(
      DEPLOYED_HERE.flatMap((environment) =>
        stackList(synthesize(environment).stacks)
          .map((stack) => stack.stackName.replace(`listora-${environment}-`, ''))
          .filter((name) => name !== 'deploy-access'),
      ),
    );
    expect([...deployed].sort()).toEqual([...expected].sort());
  });

  it('builds and pushes both images, application and browser runner, tagged with the commit', () => {
    const run = job.steps[stepIndex('Build and push the application image')]?.run ?? '';
    expect(run).toContain('for target in app runner; do');
    expect(run).toContain('image="$registry/listora/$target:$LISTORA_IMAGE_TAG"');
    expect(run).toContain('docker build --target "$target" --tag "$image" .');
    // Tags are immutable: an image pushed before is reused, never pushed again.
    expect(run).toContain('continue');
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
    // The step runs scripts/run-migrations.sh, which scripts/deploy-personal.sh runs too.
    const step = job.steps[stepIndex('Run schema migrations')]?.run ?? '';
    expect(step.trim()).toBe('scripts/run-migrations.sh "$LISTORA_ENV" "deploy-$GITHUB_RUN_ID"');
    const run = readFileSync(new URL('../../scripts/run-migrations.sh', import.meta.url), 'utf8');
    const names = migrateTaskNames('$environment');
    expect(run).toContain(`cluster="${names.cluster}"`);
    expect(run).toContain(`task_definition=\${3:-${names.family}}`);
    expect(run).toContain(`--task-definition "$task_definition"`);
    expect(run).toContain(`--stack-name "${names.stack}"`);
    for (const output of Object.values(MIGRATE_OUTPUTS)) expect(run).toContain(`output ${output}`);
    // The stack says whether the task needs a public address (public-IP egress, no NAT).
    expect(run).toContain(`public_ip=$(output ${MIGRATE_OUTPUTS.assignPublicIp})`);
    expect(run).toContain('assignPublicIp=$public_ip}');
    expect(run).not.toContain('aws ecs wait');
    expect(run).toContain('.tasks[0].lastStatus');
    expect(run).toMatch(/while true; do\n[\s\S]*"\$status" == STOPPED \]\]; then break; fi/);
    expect(run).toContain('.tasks[0].containers[0].exitCode');
    expect(run).toMatch(/if \[\[ "\$code" != 0 \]\]; then\n(.*\n)+?\s*exit 1/);
  });
});

const personalSource = readFileSync(
  new URL('../../.github/workflows/deploy-personal.yml', import.meta.url),
  'utf8',
);
const personal = parse(personalSource) as {
  on: Record<string, { workflows?: string[]; types?: string[]; branches?: string[] } | null>;
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, Job>;
};
const ciName = (
  parse(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')) as {
    name: string;
  }
).name;

describe('deploy personal workflow', () => {
  const pick = personal.jobs['commit'];
  const deploy = personal.jobs['deploy'];
  if (pick === undefined || deploy === undefined) {
    throw new Error('deploy-personal.yml needs its commit and deploy jobs');
  }

  it('runs after CI on main and by hand, never on pull requests', () => {
    expect(Object.keys(personal.on).sort()).toEqual(['workflow_dispatch', 'workflow_run']);
    expect(personal.on['workflow_run']).toEqual({
      workflows: [ciName],
      types: ['completed'],
      branches: ['main'],
    });
  });

  it('deploys only a commit CI passed for a push to main of this repository', () => {
    const condition = (pick.if ?? '').replace(/\s+/g, ' ');
    expect(condition).toContain(`github.ref == '${DEPLOY_BRANCH_REF}'`);
    for (const check of [
      "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.event == 'push'",
      'github.event.workflow_run.head_repository.full_name == github.repository',
    ]) {
      expect(condition).toContain(check);
    }
    expect(deploy.needs).toBe('commit');
    expect(deploy.if).toBe("needs.commit.outputs.sha != ''");
    // The commit CI tested, and only while it is still main's head.
    const run = pick.steps[0]?.run ?? '';
    expect(run).toContain('gh api "repos/$GITHUB_REPOSITORY/commits/main" --jq .sha');
    expect(run).toMatch(/if \[ "\$head" = "\$TESTED" \]; then\n\s*echo "sha=\$TESTED"/);
    const checkout = deploy.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['ref']).toBe('${{ needs.commit.outputs.sha }}');
  });

  it('never runs two deploys at once, and never cancels one that started', () => {
    expect(personal.concurrency).toEqual({ group: 'deploy-personal', 'cancel-in-progress': false });
  });

  it('assumes the personal deploy role through OIDC in the personal environment, with no AWS keys', () => {
    expect(deploy.environment).toBe('personal');
    expect(personal.permissions).toEqual({ contents: 'read' });
    expect(pick.permissions).toEqual({ contents: 'read' });
    expect(deploy.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(personalSource).not.toMatch(/aws-access-key-id|aws-secret-access-key/);
    // The one secret is the owner's address, a secret only so the public log masks it.
    expect([...personalSource.matchAll(/secrets\.(\w+)/g)].map((match) => match[1])).toEqual([
      'OWNER_EMAIL',
    ]);
    const login = deploy.steps.find((step) =>
      step.uses?.startsWith('aws-actions/configure-aws-credentials@'),
    );
    expect(login?.with?.['role-to-assume']).toBe(
      `arn:aws:iam::\${{ vars.AWS_ACCOUNT_ID }}:role/${deployRoleName('personal')}`,
    );
    expect(login?.with?.['allowed-account-ids']).toBe('${{ vars.AWS_ACCOUNT_ID }}');
  });

  it('pins every action to a commit', () => {
    for (const step of [...pick.steps, ...deploy.steps]) {
      if (step.uses !== undefined) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('deploys with scripts/deploy-personal.sh, as the deploy from a Mac does', () => {
    expect(deploy.steps.at(-1)?.run?.trim()).toBe('scripts/deploy-personal.sh --ci');
    expect(deploy.env?.['LISTORA_OWNER_EMAIL']).toBe('${{ secrets.OWNER_EMAIL }}');
  });
});
