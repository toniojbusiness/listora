import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/deploy-personal.sh', import.meta.url));
const ACCOUNT = '976033325938';
const POLICY_ARN = `arn:aws:iam::${ACCOUNT}:policy/listora-personal-cdk-execution`;

/** An answer of the fake `aws`: printed output and exit status. */
interface Answer {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly status?: number;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs the script with fake `aws`, `docker`, `git`, and `npx` first on PATH. The fake `aws`
 * answers `<service> <operation>` from `answers` (anything else fails loudly) and records every
 * call, so a test sees exactly what the script asked AWS. `npx` fails: no test may reach cdk.
 */
function deploy(args: string[], answers: Record<string, Answer> = {}, key = 'not-a-real-test-key') {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-personal-'));
  dirs.push(dir);
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  const cases = Object.entries(answers)
    .map(([operation, answer]) => {
      writeFileSync(join(dir, `${operation.replace(' ', '_')}.out`), answer.stdout ?? '');
      writeFileSync(join(dir, `${operation.replace(' ', '_')}.err`), answer.stderr ?? '');
      return `  "${operation}") cat "${dir}/${operation.replace(' ', '_')}.out"; cat "${dir}/${operation.replace(' ', '_')}.err" >&2; exit ${String(answer.status ?? 0)} ;;`;
    })
    .join('\n');
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  stub(
    'aws',
    `echo "$*" >>"${calls}"
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in --profile|--region) shift 2 ;; *) args+=("$1"); shift ;; esac
done
case "\${args[0]} \${args[1]}" in
${cases}
  *) echo "unexpected aws call: \${args[*]}" >&2; exit 99 ;;
esac`,
  );
  stub('docker', 'exit 0');
  stub(
    'git',
    'case "$1" in status) exit 0 ;; rev-parse) echo 0123456789abcdef0123456789abcdef01234567 ;; esac',
  );
  stub('npx', `echo "npx $*" >>"${calls}"; echo "npx must not run in this test" >&2; exit 98`);
  const keyFile = join(dir, 'anthropic.env');
  writeFileSync(keyFile, `ANTHROPIC_API_KEY=${key}\n# a comment\n`);
  const result = spawnSync('bash', [script, ...args, '--anthropic-env', keyFile], {
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env['PATH'] ?? ''}`, HOME: process.env['HOME'] },
  });
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean),
  };
}

const identity = (account: string): Answer => ({ stdout: `${account}\n` });
const zones: Answer = {
  stdout: 'us-east-1a\tuse1-az1\nus-east-1b\tuse1-az2\nus-east-1c\tuse1-az3\n',
};

describe('scripts/deploy-personal.sh', () => {
  it('refuses a profile of any other account before anything else', () => {
    const run = deploy(['--profile', 'other'], {
      'sts get-caller-identity': identity('111111111111'),
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain(
      `profile other is account 111111111111, not ${ACCOUNT}; refusing to deploy`,
    );
    expect(run.calls).toEqual([
      '--profile other --region us-east-1 sts get-caller-identity --query Account --output text',
    ]);
  });

  it('refuses to run without a profile', () => {
    const run = deploy([]);
    expect(run.status).toBe(1);
    expect(run.output).toContain('name the AWS profile');
    expect(run.calls).toEqual([]);
  });

  it('refuses when the Anthropic key file has no key, and never prints the key', () => {
    const empty = deploy(['--profile', 'p'], {}, '');
    expect(empty.status).toBe(1);
    expect(empty.output).toContain('has no ANTHROPIC_API_KEY= line');
    expect(empty.calls).toEqual([]);
    const present = deploy(['--profile', 'p'], { 'sts get-caller-identity': identity('1') });
    expect(present.output).toContain('Anthropic key found');
    expect(present.output).not.toContain('not-a-real-test-key');
  });

  it('refuses zones that include use1-az3 and suggests two others', () => {
    const run = deploy(['--profile', 'p'], {
      'sts get-caller-identity': identity(ACCOUNT),
      'ec2 describe-availability-zones': {
        stdout: 'us-east-1a\tuse1-az3\nus-east-1b\tuse1-az1\nus-east-1c\tuse1-az2\n',
      },
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain('set LISTORA_AVAILABILITY_ZONES=us-east-1b,us-east-1c');
  });

  it('stops at a stack that needs a person, changing nothing', () => {
    const run = deploy(['--profile', 'p'], {
      'sts get-caller-identity': identity(ACCOUNT),
      'ec2 describe-availability-zones': zones,
      'cloudformation describe-stacks': {
        stdout: JSON.stringify({ Stacks: [{ StackStatus: 'ROLLBACK_COMPLETE' }] }),
      },
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain(
      'listora-personal-registry is ROLLBACK_COMPLETE and needs a person',
    );
    expect(run.calls.some((call) => / (create|put|update|delete|run)-/.test(call))).toBe(false);
  });

  it('dry run: checks everything offline, prints every step, and never calls AWS', () => {
    const run = deploy(['--dry-run', '--profile', 'p']);
    // npx is the fake here, so synthesis fails, after the checks that need no AWS at all.
    expect(run.calls).toEqual([
      expect.stringMatching(
        /^npx cdk synth --quiet .*--context env=personal --context account=976033325938/,
      ),
    ]);
    expect(run.output).toContain('would run: aws sts get-caller-identity --profile p');
    expect(run.output).toContain('cdk synth failed');
  });
});

describe('scripts/deploy-personal.sh --dry-run with the real cdk', () => {
  it('synthesizes, checks the templates, and prints every step without calling AWS', () => {
    // Only aws is faked (and fails on any call); cdk synth runs for real, offline.
    const dir = mkdtempSync(join(tmpdir(), 'deploy-personal-dry-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'aws'), `#!/usr/bin/env bash\necho "$*" >>"${dir}/calls"; exit 99\n`);
    chmodSync(join(dir, 'aws'), 0o755);
    writeFileSync(join(dir, 'anthropic.env'), 'ANTHROPIC_API_KEY=not-a-real-dry-run-key\n');
    const result = spawnSync(
      'bash',
      [script, '--dry-run', '--profile', 'p', '--anthropic-env', join(dir, 'anthropic.env')],
      {
        encoding: 'utf8',
        env: { PATH: `${dir}:${process.env['PATH'] ?? ''}`, HOME: process.env['HOME'] },
      },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(() => readFileSync(join(dir, 'calls'))).toThrow();
    const output = result.stdout;
    for (const expected of [
      'api: AUTH_DRIVER=dev, AI_PROVIDER=anthropic (the fake AI is off)',
      'database: deletion protection on',
      `--cloudformation-execution-policies ${POLICY_ARN} --termination-protection`,
      'listora-personal-data: 6 resources',
      'scripts/run-migrations.sh personal',
      // Both images the stacks run, as the Deploy workflow builds them.
      '--target app --tag 976033325938.dkr.ecr.us-east-1.amazonaws.com/listora/app:',
      '--target runner --tag 976033325938.dkr.ecr.us-east-1.amazonaws.com/listora/runner:',
      'node infra/src/deploy/smoke.ts --api-url <ApiUrl> --auth dev --log-group /listora/personal/api',
      'dry run ok; nothing was sent to AWS',
    ]) {
      expect(output).toContain(expected);
    }
    expect(output).not.toContain('not-a-real-dry-run-key');
    // The steps run in the deploy order of .github/workflows/deploy.yml.
    const order = [
      'Verify the AWS account',
      'restricted execution policy',
      'Deploy the image repository',
      'Build and push',
      'state stacks and the migration task',
      'Store the Anthropic key',
      'Run the schema migrations',
      'Deploy the services and alarms',
      'Wait for the API',
      'Smoke test',
    ].map((title) => output.indexOf(title));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  }, 120_000);
});
