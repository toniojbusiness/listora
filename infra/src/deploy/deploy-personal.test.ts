import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/deploy-personal.sh', import.meta.url));
const ACCOUNT = '976033325938';
const POLICY_ARN = `arn:aws:iam::${ACCOUNT}:policy/listora-personal-cdk-execution`;
const OWNER = 'owner@example.com';

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
 * answers `<service> <operation>` from `answers`, or `<service> <operation> <stack>` for a call
 * naming `--stack-name <stack>` (anything else fails loudly), and records every call, so a test
 * sees exactly what the script asked AWS. `npx` fails, except `cdk synth` with `realSynth`
 * (offline, as the script runs it), so no test can reach a cdk command that talks to AWS.
 */
function deploy(
  args: string[],
  answers: Record<string, Answer> = {},
  { key = 'not-a-real-test-key', realSynth = false, owner = 'Owner@Example.com' } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-personal-'));
  dirs.push(dir);
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  for (const [operation, answer] of Object.entries(answers)) {
    const file = join(dir, `answer_${operation.replaceAll(' ', '_')}`);
    writeFileSync(`${file}.out`, answer.stdout ?? '');
    writeFileSync(`${file}.err`, answer.stderr ?? '');
    writeFileSync(`${file}.status`, String(answer.status ?? 0));
  }
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  stub(
    'aws',
    `echo "$*" >>"${calls}"
args=(); stack=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile|--region) shift 2 ;;
    --stack-name) stack=$2; args+=("$1"); shift ;;
    *) args+=("$1"); shift ;;
  esac
done
for file in "${dir}/answer_\${args[0]}_\${args[1]}_\${stack}" "${dir}/answer_\${args[0]}_\${args[1]}"; do
  if [[ -e "$file.out" ]]; then cat "$file.out"; cat "$file.err" >&2; exit "$(cat "$file.status")"; fi
done
echo "unexpected aws call: \${args[*]}" >&2; exit 99`,
  );
  stub('docker', 'exit 0');
  stub(
    'git',
    'case "$1" in status) exit 0 ;; rev-parse) echo 0123456789abcdef0123456789abcdef01234567 ;; esac',
  );
  const npx = spawnSync('bash', ['-c', 'command -v npx'], { encoding: 'utf8' }).stdout.trim();
  stub(
    'npx',
    `echo "npx $*" >>"${calls}"
if [[ -n "\${AWS_CONFIG_FILE:-}" ]]; then sed 's/^/config: /' "$AWS_CONFIG_FILE" >>"${calls}"; fi
if [[ "${String(realSynth)}" == true && "$1 $2" == "cdk synth" ]]; then exec "${npx}" "$@"; fi
echo "npx must not run in this test" >&2; exit 98`,
  );
  const keyFile = join(dir, 'anthropic.env');
  writeFileSync(keyFile, `ANTHROPIC_API_KEY=${key}\n# a comment\n`);
  const result = spawnSync('bash', [script, ...args, '--anthropic-env', keyFile], {
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env['PATH'] ?? ''}`,
      HOME: process.env['HOME'],
      LISTORA_OWNER_EMAIL: owner,
    },
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

  it('refuses to run without the owner email, the only person who can sign in', () => {
    const run = deploy(['--profile', 'p'], {}, { owner: '' });
    expect(run.status).toBe(1);
    expect(run.output).toContain('set LISTORA_OWNER_EMAIL');
    expect(run.calls).toEqual([]);
  });

  it('refuses when the Anthropic key file has no key, and never prints the key', () => {
    const empty = deploy(['--profile', 'p'], {}, { key: '' });
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

  /** Answers that pass every check before the bootstrap step: a fresh account. */
  const freshAccount: Record<string, Answer> = {
    'sts get-caller-identity': identity(ACCOUNT),
    'ec2 describe-availability-zones': zones,
    'cloudformation describe-stacks': {
      stderr: 'An error occurred (ValidationError): Stack with id x does not exist',
      status: 254,
    },
    'sesv2 get-email-identity': {
      stderr: 'An error occurred (NotFoundException) when calling the GetEmailIdentity operation',
      status: 254,
    },
  };
  const toolkit = (policies: string): Answer => ({
    stdout: JSON.stringify({
      Stacks: [
        {
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [
            { ParameterKey: 'CloudFormationExecutionPolicies', ParameterValue: policies },
          ],
        },
      ],
    }),
  });

  it('creates the owner email identity only when the account does not already have it', () => {
    const synthOf = (answers: Record<string, Answer>) => {
      const run = deploy(['--profile', 'p'], { ...freshAccount, ...answers });
      return { run, synth: run.calls.find((call) => call.startsWith('npx cdk synth')) ?? '' };
    };
    // A fresh account: the email stack creates it (and AWS emails the verification link).
    expect(synthOf({}).synth).toContain('--context ownerEmailIdentity=create');

    // Already in the account, outside Listora's stacks: left alone, never taken over.
    const outside = synthOf({
      'sesv2 get-email-identity': { stdout: '{"VerifiedForSendingStatus": true}' },
      'cloudformation list-stack-resources': { stdout: '' },
    });
    expect(outside.synth).toContain('--context ownerEmailIdentity=existing');
    expect(outside.run.output).toContain('already in the account outside Listora');

    // Made by Listora's email stack on an earlier deploy: the stack keeps managing it.
    const owned = synthOf({
      'sesv2 get-email-identity': { stdout: '{"VerifiedForSendingStatus": true}' },
      'cloudformation list-stack-resources': { stdout: `${OWNER}\n` },
    });
    expect(owned.synth).toContain('--context ownerEmailIdentity=create');
    // Three runs of the script: past the default timeout on a busy machine.
  }, 120_000);

  it("refuses Listora's bootstrap when it is not the restricted one, changing nothing", () => {
    const run = deploy(
      ['--profile', 'p'],
      {
        ...freshAccount,
        'cloudformation describe-stacks CDKToolkit-listora': toolkit(''),
      },
      { realSynth: true },
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain(
      `CDKToolkit-listora runs CloudFormation with 'AdministratorAccess (the default)', not ${POLICY_ARN}`,
    );
    // It looked only at Listora's own toolkit stack, never the account's default CDKToolkit.
    expect(run.calls.some((call) => / --stack-name CDKToolkit( |$)/.test(call))).toBe(false);
    expect(run.calls.some((call) => / (create|put|update|delete|run)-/.test(call))).toBe(false);
  }, 120_000);

  it("creates the policy and bootstraps when Listora's bootstrap does not exist yet", () => {
    const run = deploy(
      ['--profile', 'p'],
      {
        ...freshAccount,
        'iam get-policy': {
          stderr: 'An error occurred (NoSuchEntity) when calling the GetPolicy operation',
          status: 254,
        },
        'iam create-policy': { stdout: '{}' },
      },
      { realSynth: true },
    );
    // The fake npx refuses the bootstrap itself, after the policy exists.
    expect(run.output).toContain('cdk bootstrap failed');
    expect(run.calls).toContainEqual(
      expect.stringMatching(/iam create-policy --policy-name listora-personal-cdk-execution /),
    );
    expect(run.calls).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^npx cdk bootstrap aws://${ACCOUNT}/us-east-1 --app cdk.out/deploy-personal --qualifier listora --toolkit-stack-name CDKToolkit-listora --cloudformation-execution-policies ${POLICY_ARN} --termination-protection --profile listora-deploy-cdk `,
        ),
      ),
    );
    // cdk gets the profile's credentials from the AWS CLI through a private config, which
    // names the CLI command but holds no credentials.
    expect(run.calls).toContain('config: [profile listora-deploy-cdk]');
    expect(run.calls).toContainEqual(
      expect.stringMatching(
        /^config: credential_process = env AWS_CONFIG_FILE=".+" aws configure export-credentials --profile p --format process$/,
      ),
    );
    expect(run.calls.filter((call) => call.startsWith('config: '))).not.toContainEqual(
      expect.stringMatching(/aws_access_key_id|aws_secret_access_key|aws_session_token/i),
    );
  }, 120_000);

  it('goes past an existing restricted bootstrap without bootstrapping again', () => {
    const run = deploy(
      ['--profile', 'p'],
      {
        ...freshAccount,
        'cloudformation describe-stacks CDKToolkit-listora': toolkit(POLICY_ARN),
        'iam get-policy': { stdout: JSON.stringify({ Policy: { DefaultVersionId: 'v1' } }) },
        'iam get-policy-version': { stdout: '{"Version":"2012-10-17","Statement":[]}' },
        'iam list-policy-versions': { stdout: '1\n' },
        'iam create-policy-version': { stdout: '{}' },
      },
      { realSynth: true },
    );
    expect(run.output).toContain(`CDKToolkit-listora uses ${POLICY_ARN}`);
    expect(run.output).toContain(
      'listora-personal-cdk-execution updated to the committed document',
    );
    expect(run.calls.some((call) => call.startsWith('npx cdk bootstrap'))).toBe(false);
    // Every cdk command that talks to AWS first renews the sign-in through the CLI.
    const deployCall = run.calls.findIndex((call) => call.startsWith('npx cdk deploy'));
    expect(run.calls[deployCall - 1]).toMatch(/sts get-caller-identity$/);
    // Next it deploys the registry, which the fake npx refuses.
    expect(run.calls).toContainEqual(
      expect.stringMatching(
        /^npx cdk deploy --app cdk.out\/deploy-personal --require-approval never listora-personal-registry/,
      ),
    );
  }, 120_000);

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
    expect(run.calls[0]).toContain(`--context ownerEmail=${OWNER}`);
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
        env: {
          PATH: `${dir}:${process.env['PATH'] ?? ''}`,
          HOME: process.env['HOME'],
          LISTORA_OWNER_EMAIL: OWNER,
        },
      },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(() => readFileSync(join(dir, 'calls'))).toThrow();
    const output = result.stdout;
    for (const expected of [
      'api: AUTH_DRIVER=cognito, AI_PROVIDER=anthropic (the fake AI is off)',
      `sign-in: the Cognito user pool, no sign-up, and ${OWNER} its only user`,
      `aws sesv2 get-email-identity --email-identity <each of ${OWNER}>`,
      'npx cdk deploy --app cdk.out/deploy-personal --require-approval never listora-personal-auth',
      'database: deletion protection on',
      `--cloudformation-execution-policies ${POLICY_ARN} --termination-protection`,
      'listora-personal-data: 6 resources',
      'scripts/run-migrations.sh personal',
      // Both images the stacks run, as the Deploy workflow builds them.
      '--target app --tag 976033325938.dkr.ecr.us-east-1.amazonaws.com/listora/app:',
      '--target runner --tag 976033325938.dkr.ecr.us-east-1.amazonaws.com/listora/runner:',
      'node infra/src/deploy/smoke.ts --api-url <ApiUrl> --auth cognito',
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
      'Wait until SES has verified',
      'Deploy the user pool',
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
